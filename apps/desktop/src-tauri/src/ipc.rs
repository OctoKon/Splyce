use crate::process::EngineChild;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Manager, WebviewWindow, ipc::Channel};

const PROTOCOL: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/splyce-pi/dist/bridge-protocol.json"
));

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeError {
    code: &'static str,
    message: &'static str,
    correlation_id: String,
    retryable: bool,
}

impl BridgeError {
    fn denied() -> Self {
        Self {
            code: "POLICY_DENIED",
            message: "Native command unavailable",
            correlation_id: "native-validation".into(),
            retryable: false,
        }
    }
    fn engine() -> Self {
        Self {
            code: "ENGINE_CRASH",
            message: "Engine connection unavailable",
            correlation_id: "native-transport".into(),
            retryable: false,
        }
    }
}

struct Inner {
    child: Option<EngineChild>,
    lifecycle: Option<Channel<Value>>,
    closed: bool,
}

struct Subscription {
    scope_id: String,
    events: Channel<Value>,
    lifecycle: Channel<Value>,
}

#[derive(Default)]
struct Subscriptions(HashMap<String, Subscription>);

impl Subscriptions {
    fn install(
        &mut self,
        session_id: &str,
        after_seq: u64,
        acknowledged: &Value,
        events: Channel<Value>,
        lifecycle: Channel<Value>,
    ) -> Result<(), BridgeError> {
        if acknowledged
            .as_object()
            .is_none_or(|fields| fields.len() != 3)
            || acknowledged["sessionId"] != session_id
            || acknowledged["afterSeq"] != after_seq
            || !opaque(&acknowledged["scopeId"])
        {
            return Err(BridgeError::engine());
        }
        self.0.insert(
            session_id.to_owned(),
            Subscription {
                scope_id: acknowledged["scopeId"].as_str().unwrap().to_owned(),
                events,
                lifecycle,
            },
        );
        Ok(())
    }

    fn forward(&mut self, event: Value) -> Result<(), BridgeError> {
        if event["frame"] == "control" {
            if event.as_object().is_none_or(|fields| {
                fields.len() != 4
                    || !["frame", "kind", "sessionId", "fromSeq"]
                        .iter()
                        .all(|key| fields.contains_key(*key))
            }) || event["kind"] != "stream.resync"
                || !opaque(&event["sessionId"])
                || !matches_rule(&event["fromSeq"], &json!("uint"))
            {
                return Err(BridgeError::engine());
            }
            let session_id = event["sessionId"].as_str().unwrap();
            let subscription = self.0.get(session_id).ok_or_else(BridgeError::engine)?;
            if subscription.events.send(event.clone()).is_err() {
                self.0.remove(session_id);
            }
            return Ok(());
        }
        let session_id = event["sessionId"]
            .as_str()
            .ok_or_else(BridgeError::engine)?
            .to_owned();
        let Some(subscription) = self.0.get(&session_id) else {
            // A replaced/closed renderer has no recipient; durable recovery uses replay.
            return Ok(());
        };
        // DesktopBridge validates payload references and shapes in the native host;
        // this transport leg additionally binds its envelope to the authorized ACK.
        let spec: Value = serde_json::from_str(PROTOCOL).map_err(|_| BridgeError::engine())?;
        let transient = matches!(
            event["kind"].as_str(),
            Some("turn.stream_delta" | "turn.thought_delta")
        );
        if event["protocolVersion"] != spec["protocolVersion"]
            || event["schemaVersion"] != spec["schemaVersion"]
            || event["scopeId"] != subscription.scope_id
            || !opaque(&event["eventId"])
            || !opaque(&event["recordId"])
            || !event["seq"]
                .as_u64()
                .is_some_and(|seq| seq > 0 && seq <= 9_007_199_254_740_991)
            || event["durable"] != !transient
            || !matches_rule(&event["kind"], &spec["eventKinds"])
            || !matches_rule(&event["createdAt"], &json!("text"))
            || !matches_rule(&event["sourceIds"], &json!("refs"))
            || event.get("payload").is_some() == event.get("payloadArtifactId").is_some()
            || event.as_object().is_none_or(|fields| {
                fields.keys().any(|field| {
                    ![
                        "schemaVersion",
                        "protocolVersion",
                        "recordId",
                        "eventId",
                        "createdAt",
                        "sourceIds",
                        "scopeId",
                        "sessionId",
                        "seq",
                        "durable",
                        "kind",
                        "payload",
                        "payloadArtifactId",
                    ]
                    .contains(&field.as_str())
                })
            })
            || (event["kind"] == "engine.status"
                && event
                    .get("payload")
                    .and_then(|payload| payload.get("ports"))
                    .is_some_and(|ports| !valid_ports(ports)))
            || event.get("payloadArtifactId").is_some_and(|id| !opaque(id))
            || event.get("payload").is_some_and(|payload| {
                !payload.is_object()
                    || serde_json::to_vec(payload).map_or(true, |bytes| {
                        bytes.len() as u64
                            > spec["transportLimits"]["maxInlineBytes"]
                                .as_u64()
                                .unwrap_or(0)
                    })
            })
        {
            return Err(BridgeError::engine());
        }
        if subscription.events.send(event).is_err() {
            self.0.remove(&session_id);
        }
        Ok(())
    }

    fn close(&mut self, lifecycle: &Value) {
        for (_, subscription) in self.0.drain() {
            let _ = subscription.lifecycle.send(lifecycle.clone());
        }
    }
}

#[derive(Clone)]
pub struct BridgeState {
    inner: Arc<Mutex<Inner>>,
    subscriptions: Arc<Mutex<Subscriptions>>,
    next_id: Arc<AtomicU64>,
    workspace_busy: Arc<AtomicBool>,
}

impl BridgeState {
    pub fn start(
        directory: &Path,
        digest: &str,
        app_data_dir: &Path,
    ) -> Result<Self, crate::process::EngineError> {
        let child = EngineChild::spawn(directory, digest, app_data_dir)?;
        let events = child.events();
        let state = Self {
            inner: Arc::new(Mutex::new(Inner {
                child: Some(child),
                lifecycle: None,
                closed: false,
            })),
            subscriptions: Arc::new(Mutex::new(Subscriptions::default())),
            next_id: Arc::new(AtomicU64::new(1)),
            workspace_busy: Arc::new(AtomicBool::new(false)),
        };
        let observer = state.clone();
        std::thread::spawn(move || {
            let mut delivery_failed = false;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(100));
                let mut delivered = false;
                if !delivery_failed {
                    delivery_failed = events
                        .drain()
                        .map_err(|_| BridgeError::engine())
                        .and_then(|events| {
                            delivered = !events.is_empty();
                            let mut subscriptions = observer
                                .subscriptions
                                .lock()
                                .map_err(|_| BridgeError::engine())?;
                            for event in events {
                                subscriptions.forward(event)?;
                            }
                            Ok(())
                        })
                        .is_err();
                }
                let Ok(mut inner) = observer.inner.try_lock() else {
                    continue;
                };
                if inner.closed {
                    break;
                }
                let exited = inner
                    .child
                    .as_ref()
                    .is_some_and(|child| !child.is_running());
                if exited && delivered && !delivery_failed {
                    // Reap descendants now, then deliver every already-buffered batch
                    // before closing renderer channels and announcing the exit.
                    if inner
                        .child
                        .as_mut()
                        .is_some_and(|child| child.stop().is_ok())
                    {
                        continue;
                    }
                    delivery_failed = true;
                }
                if delivery_failed || !delivered && exited {
                    inner.closed = true;
                    drop(inner);
                    let _ = observer.finish(false);
                    break;
                }
            }
        });
        Ok(state)
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, BridgeError> {
        self.call_with_response(method, params, |_| true)
    }

    fn call_with_response(
        &self,
        method: &str,
        params: Value,
        accept_response: impl FnOnce(&Value) -> bool,
    ) -> Result<Value, BridgeError> {
        let mut inner = self.inner.try_lock().map_err(|_| BridgeError::denied())?;
        if inner.closed {
            return Err(BridgeError::engine());
        }
        let id = format!("native-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let child = inner.child.as_mut().ok_or_else(BridgeError::engine)?;
        let reply = child
            .request_with_response(
                &json!({"id":id,"method":method,"params":params}),
                accept_response,
            )
            .map_err(|_| BridgeError::engine())?;
        let object = reply.as_object().ok_or_else(BridgeError::engine)?;
        if object.len() != 3 || reply["id"] != id {
            return Err(BridgeError::engine());
        }
        match reply["ok"].as_bool() {
            Some(true) if object.contains_key("value") => Ok(reply["value"].clone()),
            Some(false) if object.contains_key("error") => Err(BridgeError::denied()),
            _ => Err(BridgeError::engine()),
        }
    }

    pub(crate) fn subscribe_channel(
        &self,
        session_id: String,
        after_seq: u64,
        on_event: Channel<Value>,
        on_lifecycle: Channel<Value>,
    ) -> Result<Value, BridgeError> {
        if !opaque(&json!(session_id)) || after_seq > 9_007_199_254_740_991 {
            return Err(BridgeError::denied());
        }
        // Resume the reader after installation, without holding delivery locks
        // during the host round trip or accepting renderer-supplied scope.
        let subscriptions = self.subscriptions.clone();
        self.call_with_response(
            "subscribe",
            json!({"sessionId":session_id,"afterSeq":after_seq}),
            move |reply| {
                if reply.as_object().is_none_or(|fields| fields.len() != 3) {
                    return false;
                }
                if reply["ok"] == false {
                    return reply.get("error").is_some();
                }
                reply["ok"] == true
                    && subscriptions.lock().is_ok_and(|mut subscriptions| {
                        subscriptions
                            .install(
                                &session_id,
                                after_seq,
                                &reply["value"],
                                on_event,
                                on_lifecycle,
                            )
                            .is_ok()
                    })
            },
        )
    }

    pub fn stop(&self) -> Result<(), BridgeError> {
        self.finish(true)
    }

    fn finish(&self, expected: bool) -> Result<(), BridgeError> {
        let mut inner = self.inner.lock().map_err(|_| BridgeError::engine())?;
        let cleanup = inner
            .child
            .as_mut()
            .map(EngineChild::stop)
            .transpose()
            .map_err(|_| BridgeError::engine());
        if cleanup.is_ok() {
            inner.child = None;
        }
        inner.closed = true;
        let mut subscriptions = self
            .subscriptions
            .lock()
            .map_err(|_| BridgeError::engine())?;
        let spec: Value = serde_json::from_str(PROTOCOL).map_err(|_| BridgeError::engine())?;
        let lifecycle = json!({"protocolVersion":spec["protocolVersion"],"kind":"engine_exited","expected":expected,"exitCode":null,"cleanupComplete":cleanup.is_ok()});
        subscriptions.close(&lifecycle);
        if let Some(channel) = inner.lifecycle.take() {
            let _ = channel.send(lifecycle);
        }
        cleanup.map(|_| ())
    }
}

fn caller(window: &WebviewWindow) -> Result<(), BridgeError> {
    if window.label() != "main" {
        return Err(BridgeError::denied());
    }
    let url = window.url().map_err(|_| BridgeError::denied())?;
    let packaged = ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")))
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    let development = cfg!(debug_assertions)
        && window
            .app_handle()
            .config()
            .build
            .dev_url
            .as_ref()
            .is_some_and(|expected| expected.origin() == url.origin());
    if !packaged && !development {
        return Err(BridgeError::denied());
    }
    Ok(())
}

fn opaque(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        !value.is_empty()
            && !value
                .chars()
                .any(|c| c.is_whitespace() || c == '/' || c == '\\')
    })
}

fn matches_rule(value: &Value, rule: &Value) -> bool {
    if let Some(allowed) = rule.as_array() {
        return value.is_string() && allowed.contains(value);
    }
    match rule.as_str() {
        Some("id" | "ref") => opaque(value),
        Some("text") => value.as_str().is_some_and(|value| !value.trim().is_empty()),
        Some("uint") => value
            .as_u64()
            .is_some_and(|value| value <= 9_007_199_254_740_991),
        Some("refs" | "strings") => value
            .as_array()
            .is_some_and(|values| values.iter().all(opaque)),
        _ => false,
    }
}

fn valid_command(op: &str, value: &Value) -> bool {
    let Ok(spec) = serde_json::from_str::<Value>(PROTOCOL) else {
        return false;
    };
    let Some(command) = value.as_object() else {
        return false;
    };
    let fields = [
        "protocolVersion",
        "correlationId",
        "sessionId",
        "scopeId",
        "expectedConfigRevision",
        "expectedProfileRevision",
        "expectedPolicyRevision",
        "op",
        "payload",
    ];
    if command.len() != fields.len()
        || !fields.iter().all(|field| command.contains_key(*field))
        || value["protocolVersion"] != spec["protocolVersion"]
        || value["op"] != op
    {
        return false;
    }
    if !["correlationId", "sessionId", "scopeId"]
        .iter()
        .all(|field| opaque(&value[*field]))
        || ![
            "expectedConfigRevision",
            "expectedProfileRevision",
            "expectedPolicyRevision",
        ]
        .iter()
        .all(|field| matches_rule(&value[*field], &json!("text")))
    {
        return false;
    }
    let Some(required) = spec["commands"][op].as_object() else {
        return false;
    };
    let Some(payload) = value["payload"].as_object() else {
        return false;
    };
    let optional = spec["optional"][op].as_object();
    required.iter().all(|(field, rule)| {
        payload
            .get(field)
            .is_some_and(|value| matches_rule(value, rule))
    }) && payload.iter().all(|(field, value)| {
        required
            .get(field)
            .or_else(|| optional.and_then(|rules| rules.get(field)))
            .is_some_and(|rule| matches_rule(value, rule))
    })
}

fn valid_setup(op: &str, value: &Value) -> bool {
    let fields = ["frame", "command", "requestId", "payload"];
    value.as_object().is_some_and(|object| {
        object.len() == fields.len() && fields.iter().all(|key| object.contains_key(*key))
    }) && value["frame"] == "setup"
        && value["command"] == "metadata"
        && op == "metadata"
        && opaque(&value["requestId"])
        && value["requestId"]
            .as_str()
            .is_some_and(|id| id.len() <= 128)
        && value["payload"]
            .as_object()
            .is_some_and(|payload| payload.is_empty())
}

fn valid_ports(value: &Value) -> bool {
    let Some(ports) = value.as_object() else {
        return false;
    };
    let keys = ["generation", "provider", "workspace", "modules"];
    ports.len() == keys.len()
        && keys
            .iter()
            .all(|key| ports.get(*key).is_some_and(Value::is_boolean))
}

fn valid_handshake(value: &Value, spec: &Value) -> bool {
    let Some(readiness) = value["readiness"].as_object() else {
        return false;
    };
    let Some(ports) = readiness.get("ports").and_then(Value::as_object) else {
        return false;
    };
    let ready = readiness.get("state") == Some(&json!("ready"));
    value.as_object().is_some_and(|fields| fields.len() == 8)
        && value["schemaVersion"] == spec["schemaVersion"]
        && value["protocolVersion"] == spec["protocolVersion"]
        && value["engineProtocolVersion"] == spec["protocolVersion"]
        && value["bridgeProtocolVersion"] == spec["protocolVersion"]
        && value["piRevision"] == spec["piRevision"]
        && value["entryMode"] == spec["foundation"]["entryMode"]
        && value["disabledBuiltinExtensions"] == spec["foundation"]["disabledBuiltinExtensions"]
        && readiness.len() == 5
        && (ready || readiness.get("state") == Some(&json!("unavailable")))
        && ["policy", "store", "receipts"]
            .iter()
            .all(|key| readiness.get(*key).is_some_and(Value::is_boolean))
        && (!ready
            || ["policy", "store", "receipts"]
                .iter()
                .all(|key| readiness.get(*key) == Some(&json!(true))))
        && valid_ports(&readiness["ports"])
        && (ready || ports.values().all(|value| value == &json!(false)))
}

#[tauri::command]
pub async fn handshake(
    window: WebviewWindow,
    state: tauri::State<'_, BridgeState>,
    protocol_version: u32,
    on_lifecycle: Channel<Value>,
) -> Result<Value, BridgeError> {
    caller(&window)?;
    let spec: Value = serde_json::from_str(PROTOCOL).map_err(|_| BridgeError::engine())?;
    if json!(protocol_version) != spec["protocolVersion"] {
        return Err(BridgeError::denied());
    }
    state
        .inner
        .try_lock()
        .map_err(|_| BridgeError::denied())?
        .lifecycle = Some(on_lifecycle);
    let value = state.call("handshake", json!({"protocolVersion": protocol_version}))?;
    if !valid_handshake(&value, &spec) {
        return Err(BridgeError::engine());
    }
    Ok(value)
}

#[tauri::command]
pub async fn send(
    window: WebviewWindow,
    state: tauri::State<'_, BridgeState>,
    op: String,
    payload: Value,
) -> Result<Value, BridgeError> {
    caller(&window)?;
    let setup = payload["frame"] == "setup";
    let correlation_field = if setup { "requestId" } else { "correlationId" };
    if !(if setup {
        valid_setup(&op, &payload)
    } else {
        valid_command(&op, &payload)
    }) {
        let mut error = BridgeError::denied();
        if setup
            && opaque(&payload["requestId"])
            && payload["requestId"]
                .as_str()
                .is_some_and(|id| id.len() <= 128)
        {
            error.correlation_id = payload["requestId"].as_str().unwrap().to_owned();
        }
        return Err(error);
    }
    let correlation = payload[correlation_field]
        .as_str()
        .unwrap_or("native-validation")
        .to_owned();
    state.call("send", payload).map_err(|mut error| {
        error.correlation_id = correlation;
        error
    })
}

#[tauri::command]
pub async fn cancel(
    window: WebviewWindow,
    state: tauri::State<'_, BridgeState>,
    session_id: String,
    reason: Option<String>,
) -> Result<Value, BridgeError> {
    caller(&window)?;
    if !opaque(&json!(session_id)) {
        return Err(BridgeError::denied());
    }
    state.call("cancel", json!({"sessionId":session_id,"reason":reason}))
}

#[tauri::command]
pub async fn subscribe(
    window: WebviewWindow,
    state: tauri::State<'_, BridgeState>,
    session_id: String,
    after_seq: u64,
    on_event: Channel<Value>,
    on_lifecycle: Channel<Value>,
) -> Result<Value, BridgeError> {
    caller(&window)?;
    state.subscribe_channel(session_id, after_seq, on_event, on_lifecycle)
}

struct WorkspaceLease(Arc<AtomicBool>);

impl WorkspaceLease {
    fn acquire(busy: &Arc<AtomicBool>) -> Result<Arc<Self>, BridgeError> {
        busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| BridgeError::denied())?;
        Ok(Arc::new(Self(busy.clone())))
    }
}

impl Drop for WorkspaceLease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct WorkspaceRequest(Arc<AtomicBool>);

impl Drop for WorkspaceRequest {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn active_workspace_request(active: &AtomicBool) -> Result<(), BridgeError> {
    if active.load(Ordering::Acquire) {
        Ok(())
    } else {
        Err(BridgeError::denied())
    }
}

fn receive_workspace_selection(
    receiver: std::sync::mpsc::Receiver<
        Result<Option<crate::workspace::QualifiedDirectory>, BridgeError>,
    >,
    active: &AtomicBool,
    timeout: std::time::Duration,
) -> Result<Option<crate::workspace::QualifiedDirectory>, BridgeError> {
    receiver.recv_timeout(timeout).map_err(|_| {
        active.store(false, Ordering::Release);
        BridgeError::denied()
    })?
}

fn workspace_selection(value: Value) -> Result<Value, BridgeError> {
    let fields = ["workspaceId", "displayName", "admittedAt", "revision"];
    if value.as_object().is_none_or(|object| {
        object.len() != fields.len() || !fields.iter().all(|key| object.contains_key(*key))
    }) || !opaque(&value["workspaceId"])
        || !["displayName", "admittedAt", "revision"]
            .iter()
            .all(|key| matches_rule(&value[*key], &json!("text")))
    {
        return Err(BridgeError::engine());
    }
    Ok(json!({"selectionRef":value["workspaceId"],"workspace":value}))
}

fn admit_selected(
    selected: crate::workspace::QualifiedDirectory,
    admit: impl FnOnce(Value) -> Result<Value, BridgeError>,
) -> Result<Value, BridgeError> {
    selected.verify().map_err(|_| BridgeError::denied())?;
    let canonical_path = selected.path().to_str().ok_or_else(BridgeError::denied)?;
    let identity = selected.identity();
    let value = admit(json!({
        "canonicalPath":canonical_path,
        "volumeSerial":identity.volume_serial.to_string(),
        "fileId":identity.file_id.to_string(),
    }))?;
    // Keep the selected directory and its ancestors pinned through the commit ACK.
    let result = workspace_selection(value);
    drop(selected);
    result
}

#[tauri::command]
pub async fn dialog_select_workspace(
    window: WebviewWindow,
    state: tauri::State<'_, BridgeState>,
) -> Result<Value, BridgeError> {
    caller(&window)?;
    let lease = WorkspaceLease::acquire(&state.workspace_busy)?;
    let request = WorkspaceRequest(Arc::new(AtomicBool::new(true)));
    let (selected_tx, selected_rx) = std::sync::mpsc::sync_channel(1);
    let owner = window.clone();
    let chooser_lease = lease.clone();
    let chooser_active = request.0.clone();
    window
        .run_on_main_thread(move || {
            let _lease = chooser_lease;
            let selected = active_workspace_request(&chooser_active).and_then(|()| {
                caller(&owner)?;
                let handle = owner.hwnd().map_err(|_| BridgeError::denied())?;
                let selection = crate::workspace::choose_directory(handle.0.cast())
                    .map_err(|_| BridgeError::denied())?;
                active_workspace_request(&chooser_active)?;
                Ok(selection)
            });
            let _ = selected_tx.send(selected);
        })
        .map_err(|_| BridgeError::denied())?;
    let waiting_active = request.0.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        receive_workspace_selection(
            selected_rx,
            &waiting_active,
            std::time::Duration::from_secs(300),
        )
    })
    .await
    .map_err(|_| BridgeError::engine())??;
    active_workspace_request(&request.0)?;
    caller(&window)?;
    let Some(selected) = selected else {
        return Ok(Value::Null);
    };
    let bridge = state.inner().clone();
    let admission_active = request.0.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        active_workspace_request(&admission_active)?;
        caller(&window)?;
        admit_selected(selected, |params| {
            active_workspace_request(&admission_active)?;
            caller(&window)?;
            bridge.call("native.workspace.admit", params)
        })
    })
    .await
    .map_err(|_| BridgeError::engine())?;
    drop(request);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_lease_rejects_second_invocation_until_ack_releases_last_owner() {
        let busy = Arc::new(AtomicBool::new(false));
        let request = WorkspaceLease::acquire(&busy).ok().unwrap();
        let chooser = request.clone();
        assert!(WorkspaceLease::acquire(&busy).is_err());
        drop(chooser);
        assert!(WorkspaceLease::acquire(&busy).is_err());
        drop(request);
        assert!(WorkspaceLease::acquire(&busy).is_ok());
    }

    #[test]
    fn workspace_lease_has_one_winner_under_concurrent_invocations() {
        let busy = Arc::new(AtomicBool::new(false));
        let attempts = std::sync::Barrier::new(8);
        let held = std::sync::Barrier::new(8);
        let winners = AtomicU64::new(0);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    attempts.wait();
                    let lease = WorkspaceLease::acquire(&busy);
                    if lease.is_ok() {
                        winners.fetch_add(1, Ordering::Relaxed);
                    }
                    held.wait();
                    drop(lease);
                });
            }
        });
        assert_eq!(winners.load(Ordering::Relaxed), 1);
        assert!(WorkspaceLease::acquire(&busy).is_ok());
    }

    #[test]
    fn workspace_timeout_before_ui_revokes_queued_chooser() {
        let request = WorkspaceRequest(Arc::new(AtomicBool::new(true)));
        let (_sender, receiver) = std::sync::mpsc::sync_channel(1);
        assert!(
            receive_workspace_selection(receiver, &request.0, std::time::Duration::ZERO).is_err()
        );
        assert!(active_workspace_request(&request.0).is_err());
    }

    #[test]
    fn workspace_late_selection_cannot_reach_store_or_release_live_chooser_lease() {
        let busy = Arc::new(AtomicBool::new(false));
        let lease = WorkspaceLease::acquire(&busy).ok().unwrap();
        let chooser_lease = lease.clone();
        let request = WorkspaceRequest(Arc::new(AtomicBool::new(true)));
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        assert!(
            receive_workspace_selection(receiver, &request.0, std::time::Duration::ZERO).is_err()
        );
        drop(lease);
        assert!(WorkspaceLease::acquire(&busy).is_err());
        assert!(active_workspace_request(&request.0).is_err());
        assert!(sender.send(Ok(None)).is_err());
        drop(chooser_lease);
        assert!(WorkspaceLease::acquire(&busy).is_ok());
    }

    #[test]
    fn workspace_canceled_request_revokes_callbacks_and_dispatch() {
        let request = WorkspaceRequest(Arc::new(AtomicBool::new(true)));
        let callback_active = request.0.clone();
        assert!(active_workspace_request(&callback_active).is_ok());
        drop(request);
        assert!(active_workspace_request(&callback_active).is_err());
    }

    #[test]
    fn workspace_selection_rejects_private_or_incomplete_responses() {
        let view = json!({"workspaceId":"ws-test","displayName":"project","admittedAt":"2026-10-27T00:00:00Z","revision":"1"});
        assert_eq!(
            workspace_selection(view.clone()).ok(),
            Some(json!({"selectionRef":"ws-test","workspace":view}))
        );
        for field in ["canonicalPath", "volumeSerial", "fileId", "secret"] {
            let mut invalid = view.clone();
            invalid[field] = json!("private");
            assert!(workspace_selection(invalid).is_err());
        }
        for field in ["workspaceId", "displayName", "admittedAt", "revision"] {
            let mut invalid = view.clone();
            invalid.as_object_mut().unwrap().remove(field);
            assert!(workspace_selection(invalid).is_err());
        }
    }

    #[test]
    fn qualified_selection_keeps_handles_through_admission_ack() {
        let path = std::env::temp_dir().join(format!(
            "splyce-admit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        let selected = crate::workspace::qualify_directory(&path).unwrap();
        let expected_path = selected.path().to_str().unwrap().to_owned();
        let identity = selected.identity();
        let selection = admit_selected(selected, |params| {
            assert_eq!(params, json!({"canonicalPath":expected_path,"volumeSerial":identity.volume_serial.to_string(),"fileId":identity.file_id.to_string()}));
            assert!(std::fs::rename(&path, path.with_extension("moved")).is_err());
            Ok(json!({"workspaceId":"ws-native","displayName":"project","admittedAt":"2026-10-27T00:00:00Z","revision":"1"}))
        }).ok().unwrap();
        assert_eq!(selection["selectionRef"], "ws-native");
        std::fs::remove_dir(path).unwrap();
    }

    fn recording_channel() -> (Channel<Value>, Arc<Mutex<Vec<Value>>>) {
        let received = Arc::new(Mutex::new(Vec::new()));
        let sink = received.clone();
        let channel = Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(body) = body else {
                panic!("Expected JSON native channel delivery");
            };
            sink.lock()
                .unwrap()
                .push(serde_json::from_str(&body).unwrap());
            Ok(())
        });
        (channel, received)
    }

    fn event() -> Value {
        json!({"schemaVersion":1,"protocolVersion":2,"recordId":"record1","eventId":"event1","createdAt":"2026-10-26T00:00:00.000Z","sourceIds":[],"sessionId":"s1","scopeId":"w1","seq":1,"durable":false,"kind":"turn.stream_delta","payload":{"runId":"r1","delta":"hello"}})
    }

    #[test]
    fn handshake_requires_exact_ports_and_consistent_readiness() {
        let spec: Value = serde_json::from_str(PROTOCOL).unwrap();
        let mut value = json!({"protocolVersion": spec["protocolVersion"], "schemaVersion": spec["schemaVersion"],
            "engineProtocolVersion": spec["protocolVersion"], "bridgeProtocolVersion": spec["protocolVersion"],
            "piRevision": spec["piRevision"], "entryMode": spec["foundation"]["entryMode"],
            "disabledBuiltinExtensions": spec["foundation"]["disabledBuiltinExtensions"],
            "readiness": {"state":"ready", "policy":true, "store":true, "receipts":true,
                "ports":{"generation":true,"provider":false,"workspace":false,"modules":false}}});
        assert!(valid_handshake(&value, &spec));
        value["readiness"]["ports"]["generation"] = json!("true");
        assert!(!valid_handshake(&value, &spec));
        value["readiness"]["ports"]["generation"] = json!(true);
        value["readiness"]["state"] = json!("unavailable");
        assert!(!valid_handshake(&value, &spec));
        value["readiness"]["state"] = json!("ready");
        value["readiness"]["ports"]["extra"] = json!(false);
        assert!(!valid_handshake(&value, &spec));
        value["readiness"]["ports"]
            .as_object_mut()
            .unwrap()
            .remove("extra");
        value["readiness"]["ports"]
            .as_object_mut()
            .unwrap()
            .remove("modules");
        assert!(!valid_handshake(&value, &spec));
        value["readiness"]["ports"]["modules"] = json!(false);
        value["readiness"]["policy"] = json!(false);
        assert!(!valid_handshake(&value, &spec));
        value["readiness"]["policy"] = json!(true);
        value["protocolVersion"] = json!(1);
        assert!(!valid_handshake(&value, &spec));
    }

    #[test]
    fn native_channel_requires_exact_authorized_subscription_ack() {
        let mut subscriptions = Subscriptions::default();
        for ack in [
            json!({"sessionId":"s2","scopeId":"w1","afterSeq":0}),
            json!({"sessionId":"s1","scopeId":"w1","afterSeq":1}),
            json!({"sessionId":"s1","afterSeq":0}),
        ] {
            assert!(
                subscriptions
                    .install("s1", 0, &ack, recording_channel().0, recording_channel().0)
                    .is_err()
            );
            assert!(subscriptions.0.is_empty());
        }
        let (events, received) = recording_channel();
        assert!(
            subscriptions
                .install(
                    "s1",
                    0,
                    &json!({"sessionId":"s1","scopeId":"w1","afterSeq":0}),
                    events,
                    recording_channel().0
                )
                .is_ok()
        );
        assert!(subscriptions.forward(event()).is_ok());
        assert_eq!(received.lock().unwrap().as_slice(), &[event()]);
        let mut wrong_context = event();
        wrong_context["scopeId"] = json!("w2");
        assert!(subscriptions.forward(wrong_context).is_err());
        assert_eq!(received.lock().unwrap().len(), 1);
        for field in ["createdAt", "sourceIds"] {
            let mut incomplete = event();
            incomplete.as_object_mut().unwrap().remove(field);
            assert!(subscriptions.forward(incomplete).is_err());
        }
        let mut unknown_kind = event();
        unknown_kind["kind"] = json!("unknown.event");
        assert!(subscriptions.forward(unknown_kind).is_err());
        let mut wrong_durability = event();
        wrong_durability["durable"] = json!(true);
        assert!(subscriptions.forward(wrong_durability).is_err());
        assert_eq!(received.lock().unwrap().len(), 1);
    }

    #[test]
    fn native_channel_forwards_only_valid_resync_controls_to_current_subscription() {
        let mut subscriptions = Subscriptions::default();
        let ack = json!({"sessionId":"s1","scopeId":"w1","afterSeq":0});
        let (old_events, old_received) = recording_channel();
        assert!(
            subscriptions
                .install("s1", 0, &ack, old_events, recording_channel().0)
                .is_ok()
        );
        let (events, received) = recording_channel();
        assert!(
            subscriptions
                .install("s1", 0, &ack, events, recording_channel().0)
                .is_ok()
        );
        let control =
            json!({"frame":"control","kind":"stream.resync","sessionId":"s1","fromSeq":0});
        let mut nonzero = control.clone();
        nonzero["fromSeq"] = json!(9_007_199_254_740_991_u64);
        assert!(subscriptions.forward(control.clone()).is_ok());
        assert!(subscriptions.forward(nonzero.clone()).is_ok());
        assert!(subscriptions.forward(event()).is_ok());
        assert!(old_received.lock().unwrap().is_empty());
        assert_eq!(
            received.lock().unwrap().as_slice(),
            &[control.clone(), nonzero, event()]
        );
        let mut invalid = Vec::new();
        for (key, value) in [
            ("kind", json!("other")),
            ("sessionId", json!("s2")),
            ("sessionId", json!("../s1")),
            ("fromSeq", json!(-1)),
            ("fromSeq", json!(1.5)),
            ("fromSeq", json!(9_007_199_254_740_992_u64)),
            ("scopeId", json!("w1")),
            ("seq", json!(1)),
            ("durable", json!(true)),
            ("recordId", json!("r1")),
        ] {
            let mut candidate = control.clone();
            candidate[key] = value;
            invalid.push(candidate);
        }
        let mut missing = control;
        missing.as_object_mut().unwrap().remove("fromSeq");
        invalid.push(missing);
        for candidate in invalid {
            assert!(subscriptions.forward(candidate).is_err());
        }
        assert_eq!(received.lock().unwrap().len(), 3);
    }

    #[test]
    fn native_channel_validates_status_ports_before_delivery() {
        let mut subscriptions = Subscriptions::default();
        let (events, received) = recording_channel();
        assert!(
            subscriptions
                .install(
                    "s1",
                    0,
                    &json!({"sessionId":"s1","scopeId":"w1","afterSeq":0}),
                    events,
                    recording_channel().0,
                )
                .is_ok()
        );
        let mut status = event();
        status["kind"] = json!("engine.status");
        status["durable"] = json!(true);
        status["payload"] = json!({"state":"ready","activeWorkers":0});
        assert!(subscriptions.forward(status.clone()).is_ok());
        let valid = json!({"generation":true,"provider":false,"workspace":false,"modules":false});
        for ports in [
            json!({}),
            json!({"generation":1,"provider":false,"workspace":false,"modules":false}),
            json!({"generation":false,"provider":false,"workspace":false,"modules":false,"extra":false}),
        ] {
            status["payload"]["ports"] = ports;
            assert!(subscriptions.forward(status.clone()).is_err());
            assert_eq!(received.lock().unwrap().len(), 1);
        }
        status["payload"]["ports"] = valid;
        assert!(subscriptions.forward(status.clone()).is_ok());
        assert_eq!(received.lock().unwrap().as_slice()[1], status);
    }

    #[test]
    fn replacing_and_closing_native_channels_releases_old_recipients() {
        let mut subscriptions = Subscriptions::default();
        let ack = json!({"sessionId":"s1","scopeId":"w1","afterSeq":0});
        let (old_events, old_received) = recording_channel();
        assert!(
            subscriptions
                .install("s1", 0, &ack, old_events, recording_channel().0)
                .is_ok()
        );
        let (events, received) = recording_channel();
        let (lifecycle, lifecycle_received) = recording_channel();
        assert!(
            subscriptions
                .install("s1", 0, &ack, events, lifecycle)
                .is_ok()
        );
        assert!(subscriptions.forward(event()).is_ok());
        assert!(old_received.lock().unwrap().is_empty());
        assert_eq!(received.lock().unwrap().len(), 1);
        let exited = json!({"protocolVersion":2,"kind":"engine_exited","expected":false,"exitCode":null,"cleanupComplete":true});
        subscriptions.close(&exited);
        subscriptions.close(&exited);
        assert!(subscriptions.0.is_empty());
        assert_eq!(lifecycle_received.lock().unwrap().as_slice(), &[exited]);
        assert!(subscriptions.forward(event()).is_ok());
        assert_eq!(received.lock().unwrap().len(), 1);
    }

    #[test]
    fn setup_metadata_requires_exact_sessionless_shape_and_matching_op() {
        let valid =
            json!({"frame":"setup","command":"metadata","requestId":"request1","payload":{}});
        assert!(valid_setup("metadata", &valid));
        assert!(!valid_setup("other", &valid));
        for (key, value) in [
            ("command", json!("unknown")),
            ("sessionId", json!("s1")),
            ("extra", json!(true)),
            ("payload", json!({"extra":true})),
            ("requestId", json!("bad/id")),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = value;
            assert!(!valid_setup("metadata", &invalid));
        }
    }

    #[test]
    fn shared_operations_reject_payload_authority_changes() {
        let command = json!({"protocolVersion":2,"correlationId":"request1","sessionId":"s1","scopeId":"w-demo","expectedConfigRevision":"cfg1","expectedProfileRevision":"profile1","expectedPolicyRevision":"policy1","op":"engine.restart","payload":{}});
        assert!(valid_command("engine.restart", &command));
        assert!(!valid_command("unknown", &command));
        let mut invalid = command.clone();
        invalid["payload"]["grant"] = json!(true);
        assert!(!valid_command("engine.restart", &invalid));
        invalid = command.clone();
        invalid["scopeId"] = json!("../outside");
        assert!(!valid_command("engine.restart", &invalid));
        invalid = command.clone();
        invalid["protocolVersion"] = json!(1);
        assert!(!valid_command("engine.restart", &invalid));
    }
}
