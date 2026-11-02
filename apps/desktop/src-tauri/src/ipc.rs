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
    fn selection(code: Option<&str>) -> Self {
        let code = match code {
            Some("STALE_REVISION") => "STALE_REVISION",
            Some("WORKSPACE_SUPERSEDED") => "WORKSPACE_SUPERSEDED",
            Some("SETUP_REQUEST_CONFLICT") => "SETUP_REQUEST_CONFLICT",
            _ => "POLICY_DENIED",
        };
        Self {
            code,
            message: "Setup unavailable",
            ..Self::denied()
        }
    }

    fn setup(code: &'static str) -> Self {
        Self {
            code,
            message: match code {
                "SETUP_MODEL_METADATA_REQUIRED" => {
                    "Explicit model metadata required; catalog entry unavailable"
                }
                "SETUP_CREDENTIAL_INVENTORY_UNAVAILABLE" => {
                    "Windows credential inventory could not be validated"
                }
                _ => "Provider setup unavailable",
            },
            correlation_id: "native-validation".into(),
            retryable: false,
        }
    }
    fn page_read(code: Option<&str>) -> Self {
        Self {
            code: match code {
                Some("PAGE_READ_INVALID") => "PAGE_READ_INVALID",
                _ => "PAGE_READ_UNAVAILABLE",
            },
            message: "Page data unavailable",
            ..Self::denied()
        }
    }

    fn model_catalog(code: Option<&str>) -> Self {
        Self {
            code: match code {
                Some("MODEL_CATALOG_INVALID") => "MODEL_CATALOG_INVALID",
                Some("MODEL_CATALOG_DENIED") => "MODEL_CATALOG_DENIED",
                Some("MODEL_CATALOG_TIMEOUT") => "MODEL_CATALOG_TIMEOUT",
                _ => "MODEL_CATALOG_UNAVAILABLE",
            },
            message: "Model catalog unavailable",
            ..Self::denied()
        }
    }

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
        let page_read = method == "send"
            && is_page_read(params["command"].as_str().unwrap_or(""))
            && valid_setup(params["command"].as_str().unwrap(), &params);
        let catalog = method == "send"
            && params["command"] == "models.list"
            && valid_setup("models.list", &params);
        let selection = method == "send"
            && matches!(
                params["command"].as_str(),
                Some(
                    "profile.select"
                        | "session.start"
                        | "session.resume"
                        | "setup.read"
                        | "permission.set"
                        | "permission.read"
                )
            )
            && valid_setup(params["command"].as_str().unwrap(), &params);
        #[cfg(test)]
        let diagnostic_started = std::time::Instant::now();
        #[cfg(test)]
        let diagnostic_phase = match method {
            "handshake" => "handshake",
            "native.workspace.admit" => "workspace.admit",
            "native.provider.prepare" => "provider.prepare",
            "native.provider.commit" => "provider.commit",
            "native.provider.read" => "provider.read",
            "send" => match params["command"].as_str() {
                Some("setup.read") => "setup.read",
                Some("profile.select") => "profile.select",
                Some("session.start") => "session.start",
                Some("sessions.list") => "sessions.list",
                _ => "other-setup",
            },
            _ => "other-method",
        };
        #[cfg(test)]
        eprintln!("bridge phase={diagnostic_phase} begin");
        let mut inner = self.inner.lock().map_err(|_| BridgeError::engine())?;
        if inner.closed {
            #[cfg(test)]
            eprintln!(
                "bridge phase={diagnostic_phase} closed elapsed={:?}",
                diagnostic_started.elapsed()
            );
            return Err(BridgeError::engine());
        }
        let id = format!("native-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let child = inner.child.as_mut().ok_or_else(BridgeError::engine)?;
        let reply = child
            .request_with_response(
                &json!({"id":id,"method":method,"params":params}),
                accept_response,
            )
            .map_err(|_error| {
                #[cfg(test)]
                eprintln!(
                    "bridge phase={diagnostic_phase} transport-error={} elapsed={:?}",
                    _error.code,
                    diagnostic_started.elapsed()
                );
                BridgeError::engine()
            })?;
        #[cfg(test)]
        eprintln!(
            "bridge phase={diagnostic_phase} reply elapsed={:?}",
            diagnostic_started.elapsed()
        );
        let object = reply.as_object().ok_or_else(BridgeError::engine)?;
        if object.len() != 3 || reply["id"] != id {
            return Err(BridgeError::engine());
        }
        match reply["ok"].as_bool() {
            Some(true) if object.contains_key("value") => Ok(reply["value"].clone()),
            Some(false) if object.contains_key("error") => {
                if page_read {
                    return Err(BridgeError::page_read(reply["error"]["code"].as_str()));
                }
                if catalog {
                    return Err(BridgeError::model_catalog(reply["error"]["code"].as_str()));
                }
                if selection {
                    return Err(BridgeError::selection(reply["error"]["code"].as_str()));
                }
                if method.starts_with("native.provider.") {
                    let code = match reply["error"]["code"].as_str() {
                        Some("SETUP_INVALID") => "SETUP_INVALID",
                        Some("SETUP_REQUEST_CONFLICT") => "SETUP_REQUEST_CONFLICT",
                        Some("SETUP_STALE_REVISION" | "ENTITY_STALE_REVISION") => {
                            "SETUP_STALE_REVISION"
                        }
                        Some("SETUP_WORKSPACE_UNAVAILABLE") => "SETUP_WORKSPACE_UNAVAILABLE",
                        Some("SETUP_CREDENTIAL_UNAVAILABLE") => "SETUP_CREDENTIAL_UNAVAILABLE",
                        Some("SETUP_CREDENTIAL_RESERVATION_ORPHANED") => {
                            "SETUP_CREDENTIAL_RESERVATION_ORPHANED"
                        }
                        Some("SETUP_DESCRIPTOR_UNAVAILABLE") => "SETUP_DESCRIPTOR_UNAVAILABLE",
                        Some("SETUP_UNAVAILABLE") => "SETUP_UNAVAILABLE",
                        Some("SETUP_MODEL_METADATA_REQUIRED") => "SETUP_MODEL_METADATA_REQUIRED",
                        _ => "SETUP_OUTCOME_UNKNOWN",
                    };
                    Err(BridgeError::setup(code))
                } else {
                    Err(BridgeError::denied())
                }
            }
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
        && value["command"] == op
        && opaque(&value["requestId"])
        && value["requestId"]
            .as_str()
            .is_some_and(|id| id.len() <= 128)
        && ((op == "metadata"
            && value["payload"]
                .as_object()
                .is_some_and(|payload| payload.is_empty()))
            || (op == "provider.configure"
                && valid_provider_setup(&value["payload"], &value["requestId"]))
            || (op == "setup.read"
                && exact_fields(&value["payload"], &["requestId", "workspaceId"])
                && value["payload"]["requestId"] == value["requestId"]
                && setup_id(&value["payload"]["requestId"])
                && setup_id(&value["payload"]["workspaceId"]))
            || (op == "models.list"
                && exact_fields(
                    &value["payload"],
                    &["requestId", "workspaceId", "profileId"],
                )
                && value["payload"]["requestId"] == value["requestId"]
                && ["requestId", "workspaceId", "profileId"]
                    .iter()
                    .all(|key| setup_id(&value["payload"][*key])))
            || (matches!(op, "permission.set" | "permission.read" | "session.resume")
                && valid_permission_request(op, value))
            || (is_page_read(op) && valid_page_read_request(op, value))
            || (matches!(op, "profile.select" | "session.start") && {
                let fields: &[&str] = if op == "profile.select" {
                    &[
                        "requestId",
                        "workspaceId",
                        "profileId",
                        "expectedProfileRevision",
                        "expectedConfigRevision",
                    ]
                } else {
                    &[
                        "requestId",
                        "workspaceId",
                        "profileId",
                        "expectedConfigRevision",
                    ]
                };
                let payload = &value["payload"];
                exact_fields(payload, fields)
                    && payload["requestId"] == value["requestId"]
                    && fields.iter().all(|field| setup_id(&payload[*field]))
            }))
}

fn valid_permission_request(op: &str, frame: &Value) -> bool {
    let fields: &[&str] = if op == "permission.set" {
        &["requestId", "workspaceId", "sessionId", "mode"]
    } else {
        &["requestId", "workspaceId", "sessionId"]
    };
    let payload = &frame["payload"];
    exact_fields(payload, fields)
        && payload["requestId"] == frame["requestId"]
        && ["requestId", "workspaceId", "sessionId"]
            .iter()
            .all(|field| permission_id(&payload[*field]))
        && (op != "permission.set"
            || matches!(payload["mode"].as_str(), Some("manual" | "auto" | "bypass")))
}

fn valid_permission_result(value: &Value, request: &Value) -> bool {
    exact_fields(value, &["workspaceId", "sessionId", "mode"])
        && permission_id(&value["workspaceId"])
        && permission_id(&value["sessionId"])
        && value["workspaceId"] == request["workspaceId"]
        && value["sessionId"] == request["sessionId"]
        && matches!(value["mode"].as_str(), Some("manual" | "auto" | "bypass"))
        && (request.get("mode").is_none() || value["mode"] == request["mode"])
}

fn permission_id(value: &Value) -> bool {
    setup_id(value) && value.as_str().is_some_and(str::is_ascii)
}

fn exact_fields(value: &Value, fields: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == fields.len() && fields.iter().all(|key| object.contains_key(*key))
    })
}

fn is_page_read(op: &str) -> bool {
    matches!(
        op,
        "sessions.list" | "memory.list" | "memory.search" | "usage.read"
    )
}

fn valid_page_read_request(op: &str, frame: &Value) -> bool {
    let payload = &frame["payload"];
    let fields: &[&str] = if op == "memory.search" {
        &["requestId", "workspaceId", "query"]
    } else {
        &["requestId", "workspaceId"]
    };
    exact_fields(payload, fields)
        && payload["requestId"] == frame["requestId"]
        && setup_id(&payload["requestId"])
        && setup_id(&payload["workspaceId"])
        && (op != "memory.search"
            || payload["query"].as_str().is_some_and(|query| {
                !query.trim().is_empty()
                    && query.len() <= 1024
                    && !query.chars().any(char::is_control)
            }))
}

fn page_timestamp(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let b = text.as_bytes();
    if b.len() != 24
        || !b.iter().enumerate().all(|(i, byte)| match i {
            4 | 7 => *byte == b'-',
            10 => *byte == b'T',
            13 | 16 => *byte == b':',
            19 => *byte == b'.',
            23 => *byte == b'Z',
            _ => byte.is_ascii_digit(),
        })
    {
        return false;
    }
    let number = |start: usize, end: usize| text[start..end].parse::<u32>().unwrap();
    let year = number(0, 4);
    let month = number(5, 7);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&number(8, 10))
        && number(11, 13) < 24
        && number(14, 16) < 60
        && number(17, 19) < 60
}

fn page_uint(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|number| number <= 9_007_199_254_740_991)
}

fn valid_page_read_view(op: &str, value: &Value) -> bool {
    if op == "usage.read" {
        return exact_fields(
            value,
            &[
                "semantics",
                "inputTokens",
                "outputTokens",
                "costUsd",
                "sessionCount",
                "runCount",
            ],
        ) && value["semantics"] == "unavailable"
            && ["inputTokens", "outputTokens", "costUsd"]
                .iter()
                .all(|key| value[*key].is_null())
            && page_uint(&value["sessionCount"])
            && page_uint(&value["runCount"]);
    }
    let (key, limit) = match op {
        "sessions.list" => ("sessions", 100),
        "memory.list" => ("entries", 100),
        "memory.search" => ("entries", 50),
        _ => return false,
    };
    if !exact_fields(value, &[key, "truncated"]) || !value["truncated"].is_boolean() {
        return false;
    }
    let Some(entries) = value[key].as_array() else {
        return false;
    };
    let mut seen = std::collections::HashSet::new();
    entries.len() <= limit
        && entries.iter().all(|entry| {
            if op == "sessions.list" {
                exact_fields(
                    entry,
                    &[
                        "sessionId",
                        "branchAnchorId",
                        "createdAt",
                        "updatedAt",
                        "state",
                    ],
                ) && setup_id(&entry["sessionId"])
                    && seen.insert(entry["sessionId"].as_str().unwrap())
                    && (entry["branchAnchorId"].is_null() || setup_id(&entry["branchAnchorId"]))
                    && page_timestamp(&entry["createdAt"])
                    && page_timestamp(&entry["updatedAt"])
                    && matches!(
                        entry["state"].as_str(),
                        Some(
                            "idle"
                                | "pending"
                                | "running"
                                | "completed"
                                | "failed"
                                | "canceled"
                                | "uncertain"
                        )
                    )
            } else {
                exact_fields(
                    entry,
                    &["observationId", "sessionId", "createdAt", "sourceCount"],
                ) && setup_id(&entry["observationId"])
                    && setup_id(&entry["sessionId"])
                    && seen.insert(entry["observationId"].as_str().unwrap())
                    && page_timestamp(&entry["createdAt"])
                    && page_uint(&entry["sourceCount"])
            }
        })
}

fn valid_model_catalog_view(value: &Value) -> bool {
    if !exact_fields(value, &["models", "truncated"]) || !value["truncated"].is_boolean() {
        return false;
    }
    let Some(models) = value["models"].as_array() else {
        return false;
    };
    let mut seen = std::collections::HashSet::new();
    models.len() <= 500
        && models.iter().all(|row| {
            let Some(fields) = row.as_object() else {
                return false;
            };
            let Some(id) = row["modelId"].as_str() else {
                return false;
            };
            !id.is_empty()
                && id.len() <= 256
                && seen.insert(id)
                && !id
                    .chars()
                    .any(|c| c.is_whitespace() || c.is_control() || is_format(c))
                && fields.keys().all(|key| {
                    matches!(
                        key.as_str(),
                        "modelId" | "title" | "contextWindow" | "tools" | "paidOnly"
                    )
                })
                && fields.get("title").is_none_or(|v| {
                    v.as_str().is_some_and(|t| {
                        !t.is_empty()
                            && t.encode_utf16().count() <= 256
                            && !t.chars().any(char::is_control)
                    })
                })
                && fields
                    .get("contextWindow")
                    .is_none_or(|v| v.as_u64().is_some_and(|n| (1..=2_097_152).contains(&n)))
                && fields.get("tools").is_none_or(Value::is_boolean)
                && fields.get("paidOnly").is_none_or(Value::is_boolean)
        })
}

fn is_format(c: char) -> bool {
    matches!(c as u32, 0x00ad | 0x0600..=0x0605 | 0x061c | 0x06dd | 0x070f | 0x0890..=0x0891 | 0x08e2 | 0x180e | 0x200b..=0x200f | 0x202a..=0x202e | 0x2060..=0x2064 | 0x2066..=0x206f | 0xfeff | 0xfff9..=0xfffb | 0x110bd | 0x110cd | 0x13430..=0x1343f | 0x1bca0..=0x1bca3 | 0x1d173..=0x1d17a | 0xe0001 | 0xe0020..=0xe007f)
}

fn valid_setup_read_view(value: &Value) -> bool {
    if !exact_fields(value, &["configRevision", "selectedProfileId", "profiles"])
        || !setup_id(&value["configRevision"])
        || !(value["selectedProfileId"].is_null() || setup_id(&value["selectedProfileId"]))
    {
        return false;
    }
    let Some(profiles) = value["profiles"].as_array() else {
        return false;
    };
    let mut seen = std::collections::HashSet::new();
    profiles.iter().all(|profile| {
        profile.as_object().is_some_and(|fields| {
            let base = [
                "profileId",
                "profileRevision",
                "apiFamily",
                "modelId",
                "endpointOrigin",
                "credential",
            ];
            let extra = [
                "providerConnectionId",
                "connectionRevision",
                "endpointRevision",
                "endpoint",
                "locality",
            ];
            base.iter().all(|key| fields.contains_key(*key))
                && fields.keys().all(|key| {
                    base.contains(&key.as_str()) || extra.contains(&key.as_str()) || key == "model"
                })
                && (extra.iter().all(|key| !fields.contains_key(*key))
                    && !fields.contains_key("model")
                    || extra.iter().all(|key| fields.contains_key(*key))
                        && [
                            "providerConnectionId",
                            "connectionRevision",
                            "endpointRevision",
                        ]
                        .iter()
                        .all(|key| setup_id(&profile[*key]))
                        && canonical_setup_endpoint(&profile["endpoint"], &profile["locality"])
                            .is_some()
                        && tauri::Url::parse(profile["endpoint"].as_str().unwrap()).is_ok_and(
                            |url| url.origin().ascii_serialization() == profile["endpointOrigin"],
                        )
                        && fields.get("model").is_none_or(valid_catalog_profile_model))
        }) && setup_id(&profile["profileId"])
            && setup_id(&profile["profileRevision"])
            && seen.insert(profile["profileId"].as_str().unwrap())
            && matches!(
                profile["apiFamily"].as_str(),
                Some("openai-completions" | "openai-responses")
            )
            && matches!(
                profile["credential"].as_str(),
                Some("configured" | "missing")
            )
            && profile["modelId"].as_str().is_some_and(|model| {
                !model.is_empty()
                    && model.len() <= 256
                    && !model.chars().any(|c| c.is_whitespace() || c.is_control())
            })
            && profile["endpointOrigin"].as_str().is_some_and(|origin| {
                origin.len() <= 2048
                    && tauri::Url::parse(origin).is_ok_and(|url| {
                        matches!(url.scheme(), "http" | "https")
                            && url.host_str().is_some()
                            && url.origin().ascii_serialization() == origin
                    })
            })
    }) && (value["selectedProfileId"].is_null()
        || profiles
            .iter()
            .any(|profile| profile["profileId"] == value["selectedProfileId"]))
}

fn valid_catalog_profile_model(value: &Value) -> bool {
    if !exact_fields(
        value,
        &["contextWindow", "maxOutputTokens", "reasoning", "input"],
    ) || !value["reasoning"].is_boolean()
    {
        return false;
    }
    let Some(context) = value["contextWindow"]
        .as_u64()
        .filter(|n| (1..=2_097_152).contains(n))
    else {
        return false;
    };
    let Some(input) = value["input"].as_array() else {
        return false;
    };
    value["maxOutputTokens"]
        .as_u64()
        .is_some_and(|n| (1..=context.min(1_048_576)).contains(&n))
        && !input.is_empty()
        && input.len() <= 2
        && input
            .iter()
            .all(|v| matches!(v.as_str(), Some("text" | "image")))
        && (input.len() < 2 || input[0] != input[1])
}

fn setup_id(value: &Value) -> bool {
    opaque(value)
        && value
            .as_str()
            .is_some_and(|id| id.len() <= 128 && !id.chars().any(char::is_control))
}

fn valid_setup_revision(value: &Value, prefix: char) -> bool {
    if value.is_null() {
        return true;
    }
    value
        .as_str()
        .and_then(|revision| revision.strip_prefix(prefix))
        .is_some_and(|number| {
            !number.starts_with('0')
                && !number.is_empty()
                && number.bytes().all(|byte| byte.is_ascii_digit())
                && number
                    .parse::<u64>()
                    .is_ok_and(|number| number < 9_007_199_254_740_991)
        })
}

fn canonical_setup_endpoint(value: &Value, locality: &Value) -> Option<String> {
    let raw = value.as_str()?;
    if raw.len() > 2048
        || raw
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "\\#?@".contains(c))
    {
        return None;
    }
    let url = tauri::Url::parse(raw).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let authority_end = raw.find("://")? + 3;
    let path = raw[authority_end..]
        .find('/')
        .map_or("", |index| &raw[authority_end + index..]);
    if path.contains("//")
        || path.split('/').any(|part| {
            matches!(
                part.to_ascii_lowercase().replace("%2e", ".").as_str(),
                "." | ".."
            )
        })
    {
        return None;
    }
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !((locality == "loopback" && loopback && matches!(url.scheme(), "http" | "https"))
        || (locality == "hosted" && !loopback && url.scheme() == "https"))
    {
        return None;
    }
    let canonical = format!(
        "{}{}",
        url.origin().ascii_serialization(),
        url.path().trim_end_matches('/')
    );
    (canonical == raw).then_some(canonical)
}

fn valid_provider_setup(value: &Value, request_id: &Value) -> bool {
    let fields = [
        "requestId",
        "workspaceId",
        "providerConnectionId",
        "profileId",
        "apiFamily",
        "endpoint",
        "locality",
        "chat",
        "accountScopeRef",
        "credential",
        "expectedConnectionRevision",
        "expectedProfileRevision",
        "expectedEndpointRevision",
    ];
    exact_fields(value, &fields)
        && value["requestId"] == *request_id
        && [
            "requestId",
            "workspaceId",
            "providerConnectionId",
            "profileId",
        ]
        .iter()
        .all(|key| setup_id(&value[*key]))
        && matches!(
            value["apiFamily"].as_str(),
            Some("openai-completions" | "openai-responses")
        )
        && value["accountScopeRef"] == "provider-default"
        && canonical_setup_endpoint(&value["endpoint"], &value["locality"]).is_some()
        && valid_setup_chat(&value["chat"])
        && valid_setup_revision(&value["expectedConnectionRevision"], 'c')
        && valid_setup_revision(&value["expectedProfileRevision"], 'p')
        && valid_setup_revision(&value["expectedEndpointRevision"], 'r')
        && ((exact_fields(&value["credential"], &["kind", "secret"])
            && value["credential"]["kind"] == "new"
            && value["credential"]["secret"].is_string())
            || (exact_fields(&value["credential"], &["kind"])
                && value["credential"]["kind"] == "keep"
                && !value["expectedConnectionRevision"].is_null()))
}

fn valid_setup_chat(chat: &Value) -> bool {
    let Some(fields) = chat.as_object() else {
        return false;
    };
    if !(exact_fields(chat, &["modelId"]) || exact_fields(chat, &["modelId", "model"]))
        || !chat["modelId"].as_str().is_some_and(|model| {
            !model.is_empty()
                && model.encode_utf16().count() <= 256
                && !model.chars().any(|c| c.is_whitespace() || c.is_control())
        })
    {
        return false;
    }
    if !fields.contains_key("model") {
        return true;
    }
    let model = &chat["model"];
    let Some(fields) = model.as_object() else {
        return false;
    };
    fields.contains_key("contextWindow")
        && fields.contains_key("maxOutputTokens")
        && fields.keys().all(|key| {
            matches!(
                key.as_str(),
                "contextWindow" | "maxOutputTokens" | "reasoning" | "input"
            )
        })
        && model["contextWindow"]
            .as_u64()
            .is_some_and(|value| value > 0 && value <= 1 << 21)
        && model["maxOutputTokens"].as_u64().is_some_and(|value| {
            value > 0 && value <= 1 << 20 && value <= model["contextWindow"].as_u64().unwrap()
        })
        && (!fields.contains_key("reasoning") || model["reasoning"].is_boolean())
        && (!fields.contains_key("input")
            || model["input"].as_array().is_some_and(|input| {
                !input.is_empty()
                    && input.len() <= 2
                    && input
                        .iter()
                        .all(|value| value == "text" || value == "image")
                    && (input.len() != 2 || input[0] != input[1])
            }))
}

fn setup_metadata(
    mut payload: Value,
) -> Result<(Value, Option<crate::credentials::SecretBuffer>), BridgeError> {
    if !valid_provider_setup(&payload, &payload["requestId"]) {
        return Err(BridgeError::setup("SETUP_INVALID"));
    }
    if let Some(model) = payload["chat"]
        .get_mut("model")
        .and_then(Value::as_object_mut)
    {
        model.entry("reasoning").or_insert(json!(false));
        model.entry("input").or_insert(json!(["text"]));
    }
    let credential = payload
        .as_object_mut()
        .unwrap()
        .remove("credential")
        .unwrap();
    let kind = credential["kind"].as_str().unwrap();
    let secret = if kind == "new" {
        let Value::Object(mut fields) = credential else {
            unreachable!()
        };
        let Value::String(raw) = fields.remove("secret").unwrap() else {
            unreachable!()
        };
        Some(
            crate::credentials::SecretBuffer::from_string(raw)
                .map_err(|_| BridgeError::setup("SETUP_INVALID"))?,
        )
    } else {
        None
    };
    payload.as_object_mut().unwrap().insert(
        "credentialKind".into(),
        json!(if secret.is_some() { "new" } else { "keep" }),
    );
    if let Some(secret) = &secret {
        if secret.as_bytes().len() < 8 {
            return Err(BridgeError::setup("SETUP_INVALID"));
        }
        let metadata = setup_text(&payload);
        if crate::credentials::contains_secret_form(&metadata, secret) {
            return Err(BridgeError::setup("SETUP_INVALID"));
        }
    }
    Ok((payload, secret))
}

fn setup_text(value: &Value) -> String {
    fn collect(value: &Value, output: &mut String) {
        match value {
            Value::String(text) => {
                output.push_str(text);
                output.push('\n');
            }
            Value::Object(fields) => {
                for (key, value) in fields {
                    output.push_str(key);
                    output.push('\n');
                    collect(value, output);
                }
            }
            Value::Array(values) => {
                for value in values {
                    collect(value, output);
                }
            }
            Value::Number(number) => {
                output.push_str(&number.to_string());
                output.push('\n');
            }
            Value::Bool(value) => {
                output.push_str(if *value { "true\n" } else { "false\n" });
            }
            Value::Null => output.push_str("null\n"),
        }
    }
    let mut output = String::new();
    collect(value, &mut output);
    output
}

fn setup_correlation(frame: &Value) -> Option<String> {
    let request_id = &frame["requestId"];
    if !setup_id(request_id) {
        return None;
    }
    let id = request_id.as_str()?;
    if let Some(raw) = frame["payload"]["credential"]["secret"].as_str() {
        let secret = crate::credentials::SecretBuffer::from_string(raw.to_owned()).ok()?;
        if crate::credentials::contains_secret_form(id, &secret) {
            return None;
        }
    }
    let (_, count) = crate::credentials::redact_owned(id).ok()?;
    (count == 0).then(|| id.to_owned())
}

fn valid_setup_view(view: &Value, metadata: &Value) -> bool {
    let fields = [
        "requestId",
        "workspaceId",
        "providerConnectionId",
        "profileId",
        "apiFamily",
        "locality",
        "endpointOrigin",
        "chat",
        "connectionRevision",
        "profileRevision",
        "endpointRevision",
        "configRevision",
        "credentialState",
        "generationReady",
    ];
    let Some(endpoint) = canonical_setup_endpoint(&metadata["endpoint"], &metadata["locality"])
    else {
        return false;
    };
    let Ok(url) = tauri::Url::parse(&endpoint) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    let origin = format!(
        "{}://{}:{}",
        url.scheme(),
        host,
        url.port_or_known_default().unwrap_or(0)
    );
    exact_fields(view, &fields)
        && [
            "requestId",
            "workspaceId",
            "providerConnectionId",
            "profileId",
            "apiFamily",
            "locality",
        ]
        .iter()
        .all(|key| view[*key] == metadata[*key])
        && valid_setup_chat(&view["chat"])
        && exact_fields(
            &view["chat"]["model"],
            &["contextWindow", "maxOutputTokens", "reasoning", "input"],
        )
        && view["chat"]["modelId"] == metadata["chat"]["modelId"]
        && (metadata["chat"].get("model").is_none() || view["chat"] == metadata["chat"])
        && view["endpointOrigin"] == origin
        && setup_id(&view["configRevision"])
        && view["credentialState"] == "stored"
        && view["generationReady"] == false
        && [
            ("connectionRevision", "expectedConnectionRevision", 'c'),
            ("profileRevision", "expectedProfileRevision", 'p'),
            ("endpointRevision", "expectedEndpointRevision", 'r'),
        ]
        .iter()
        .all(|(field, expected, prefix)| {
            let prior = metadata[*expected]
                .as_str()
                .and_then(|value| value[1..].parse::<u64>().ok())
                .unwrap_or(0);
            view[*field] == format!("{prefix}{}", prior + 1)
        })
}

fn configure_provider(
    payload: Value,
    call: impl Fn(&str, Value) -> Result<Value, BridgeError>,
) -> Result<Value, BridgeError> {
    use crate::credentials::{
        CredentialError, CredentialRef, ensure_reserved, read_owned, secret_bytes_equal,
    };
    use sha2::{Digest, Sha256};
    let (metadata, secret) = setup_metadata(payload)?;
    let encoded = setup_text(&metadata);
    let (_, redacted) = crate::credentials::redact_owned(&encoded)
        .map_err(|_| BridgeError::setup("SETUP_CREDENTIAL_INVENTORY_UNAVAILABLE"))?;
    if redacted != 0 {
        return Err(BridgeError::setup("SETUP_INVALID"));
    }
    let prepared = call("native.provider.prepare", metadata.clone())?;
    let replay = prepared["state"] == "replayed";
    if !(if replay {
        exact_fields(&prepared, &["state", "credentialRef", "view"])
            && valid_setup_view(&prepared["view"], &metadata)
    } else {
        prepared["state"] == "prepared"
            && exact_fields(&prepared, &["state", "credentialRef", "reservation"])
    }) {
        return Err(BridgeError::setup("SETUP_OUTCOME_UNKNOWN"));
    }
    let reference = prepared["credentialRef"]
        .as_str()
        .and_then(|value| CredentialRef::parse(value).ok())
        .ok_or_else(|| BridgeError::setup("SETUP_OUTCOME_UNKNOWN"))?;
    let present = if !replay {
        let reservation = &prepared["reservation"];
        let hash: String = Sha256::digest(metadata["requestId"].as_str().unwrap().as_bytes())
            .iter()
            .take(16)
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let expected_id = format!("setup:{hash}:credres");
        let digest = reservation["digest"].as_str().unwrap_or("");
        if !exact_fields(reservation, &["recordId", "digest", "created"])
            || reservation["recordId"] != expected_id
            || !digest.strip_prefix("sha256:").is_some_and(|value| {
                value.len() == 64
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            || !reservation["created"].is_boolean()
        {
            return Err(BridgeError::setup("SETUP_OUTCOME_UNKNOWN"));
        }
        if let Some(secret) = secret.as_ref() {
            ensure_reserved(
                &reference,
                &expected_id,
                digest,
                secret.as_str(),
                reservation["created"].as_bool().unwrap(),
            )
            .map_err(|error| {
                BridgeError::setup(match error {
                    CredentialError::ReservationConflict => "SETUP_REQUEST_CONFLICT",
                    CredentialError::ReservationOrphaned => "SETUP_CREDENTIAL_RESERVATION_ORPHANED",
                    _ => "SETUP_CREDENTIAL_UNAVAILABLE",
                })
            })?
        } else {
            read_owned(&reference)
                .map_err(|_| BridgeError::setup("SETUP_CREDENTIAL_UNAVAILABLE"))?
        }
    } else {
        read_owned(&reference).map_err(|_| BridgeError::setup("SETUP_CREDENTIAL_UNAVAILABLE"))?
    };
    if secret
        .as_ref()
        .is_some_and(|secret| !secret_bytes_equal(secret.as_bytes(), present.as_bytes()))
    {
        return Err(BridgeError::setup("SETUP_REQUEST_CONFLICT"));
    }
    drop(present);
    // Once a key exists, transport loss cannot establish whether it is referenced.
    let private = json!({"metadata":metadata,"credentialRef":reference.as_str()});
    if !replay {
        call("native.provider.commit", private.clone()).map_err(|error| {
            if matches!(
                error.code,
                "SETUP_REQUEST_CONFLICT"
                    | "SETUP_STALE_REVISION"
                    | "SETUP_WORKSPACE_UNAVAILABLE"
                    | "SETUP_INVALID"
            ) {
                error
            } else {
                BridgeError::setup("SETUP_OUTCOME_UNKNOWN")
            }
        })?;
    }
    let committed = call("native.provider.read", private)
        .map_err(|_| BridgeError::setup("SETUP_OUTCOME_UNKNOWN"))?;
    if !exact_fields(&committed, &["state", "credentialRef", "view"])
        || committed["state"] != "committed"
        || committed["credentialRef"] != reference.as_str()
        || !valid_setup_view(&committed["view"], &metadata)
    {
        return Err(BridgeError::setup("SETUP_OUTCOME_UNKNOWN"));
    }
    let present =
        read_owned(&reference).map_err(|_| BridgeError::setup("SETUP_OUTCOME_UNKNOWN"))?;
    if secret
        .as_ref()
        .is_some_and(|secret| !secret_bytes_equal(secret.as_bytes(), present.as_bytes()))
    {
        return Err(BridgeError::setup("SETUP_OUTCOME_UNKNOWN"));
    }
    Ok(committed["view"].clone())
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
    mut payload: Value,
) -> Result<Value, BridgeError> {
    caller(&window)?;
    let setup = payload["frame"] == "setup";
    let correlation_field = if setup { "requestId" } else { "correlationId" };
    if !(if setup {
        valid_setup(&op, &payload)
    } else {
        valid_command(&op, &payload)
    }) {
        let mut error = if op == "models.list" {
            BridgeError::model_catalog(Some("MODEL_CATALOG_INVALID"))
        } else if is_page_read(&op) {
            BridgeError::page_read(Some("PAGE_READ_INVALID"))
        } else {
            BridgeError::denied()
        };
        if setup && let Some(correlation) = setup_correlation(&payload) {
            error.correlation_id = correlation;
        }
        return Err(error);
    }
    let correlation = if setup {
        setup_correlation(&payload).unwrap_or_else(|| "native-validation".into())
    } else {
        payload[correlation_field]
            .as_str()
            .unwrap_or("native-validation")
            .to_owned()
    };
    let result = if setup && op == "provider.configure" {
        let setup_payload = payload.get_mut("payload").unwrap().take();
        configure_provider(setup_payload, |method, params| state.call(method, params))
    } else if setup && is_page_read(&op) {
        state.call_with_response("send", payload, |reply| {
            reply["ok"] != true || valid_page_read_view(&op, &reply["value"])
        })
    } else if setup && op == "models.list" {
        state.call_with_response("send", payload, |reply| {
            reply["ok"] != true || valid_model_catalog_view(&reply["value"])
        })
    } else if setup && op == "setup.read" {
        state.call_with_response("send", payload, |reply| {
            reply["ok"] != true || valid_setup_read_view(&reply["value"])
        })
    } else if setup && matches!(op.as_str(), "permission.set" | "permission.read") {
        let request = payload["payload"].clone();
        state.call_with_response("send", payload, |reply| {
            reply["ok"] != true || valid_permission_result(&reply["value"], &request)
        })
    } else {
        state.call("send", payload)
    };
    result.map_err(|mut error| {
        if setup && is_page_read(&op) {
            error = BridgeError::page_read(Some(error.code));
        } else if setup && op == "models.list" {
            error = BridgeError::model_catalog(Some(error.code));
        }
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

    #[cfg(windows)]
    #[test]
    fn packaged_engine_accepts_renderer_session_setup_and_page_reads() {
        use sha2::{Digest, Sha256};
        let _inventory = crate::credentials::fixture_guard();
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let engine = std::env::var_os("SPLYCE_TEST_ENGINE_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| root.join("resources/engine"));
        let manifest = std::fs::read(engine.join("manifest.json")).unwrap();
        let digest: String = Sha256::digest(manifest)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("splyce-ipc-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(directory.join("project")).unwrap();
        let state = BridgeState::start(&engine, &digest, &directory.join("data"))
            .ok()
            .unwrap();
        let result = (|| -> Result<(), BridgeError> {
            let spec: Value = serde_json::from_str(PROTOCOL).unwrap();
            eprintln!("packaged phase=initial-handshake begin");
            let handshake = state.call("handshake", json!({"protocolVersion":2}))?;
            eprintln!("packaged phase=initial-handshake end");
            assert!(valid_handshake(&handshake, &spec));
            assert_eq!(handshake["readiness"]["ports"]["generation"], false);
            let admitted = crate::workspace::qualify_directory(&directory.join("project")).unwrap();
            let workspace = admit_selected(admitted, |params| {
                state.call("native.workspace.admit", params)
            })?;
            let workspace_id = workspace["workspace"]["workspaceId"].clone();
            let mut input = provider_setup_fixture();
            input["workspaceId"] = workspace_id.clone();
            let profile = configure_provider(input, |method, params| state.call(method, params))?;
            // Match engine.sendSetup and profiles.ts payloads, including fresh request IDs.
            let setup = |command: &str, payload: Value| {
                let frame = json!({"frame":"setup", "command":command,
                    "requestId":payload["requestId"], "payload":payload});
                assert!(valid_setup(command, &frame));
                state.call_with_response("send", frame, |reply| {
                    if reply["ok"] == false {
                        eprintln!("{command}: {}", reply["error"]["code"]);
                    }
                    reply["ok"] != true
                        || if is_page_read(command) {
                            valid_page_read_view(command, &reply["value"])
                        } else if command == "setup.read" {
                            valid_setup_read_view(&reply["value"])
                        } else {
                            true
                        }
                })
            };
            let saved = setup(
                "setup.read",
                json!({"requestId":"read-setup", "workspaceId":workspace_id}),
            )?;
            assert_eq!(saved["profiles"].as_array().unwrap().len(), 1);
            let selected = setup(
                "profile.select",
                json!({"requestId":"select-profile", "workspaceId":workspace_id,
                "profileId":profile["profileId"], "expectedProfileRevision":profile["profileRevision"],
                "expectedConfigRevision":saved["configRevision"]}),
            )?;
            let started = setup(
                "session.start",
                json!({"requestId":"start-session", "workspaceId":workspace_id,
                "profileId":selected["selectedProfileId"], "expectedConfigRevision":selected["configRevision"]}),
            )?;
            assert_eq!(started["readiness"], json!({"state":"ready"}));
            let listed = setup(
                "sessions.list",
                json!({"requestId":"list-after", "workspaceId":workspace_id}),
            )?;
            assert_eq!(listed["sessions"].as_array().unwrap().len(), 1);
            assert_eq!(listed["sessions"][0]["sessionId"], started["sessionId"]);
            eprintln!("packaged phase=current-handshake begin");
            let handshake = state.call("handshake", json!({"protocolVersion":2}))?;
            eprintln!("packaged phase=current-handshake end");
            assert!(valid_handshake(&handshake, &spec));
            assert_eq!(handshake["readiness"]["ports"]["generation"], true);
            let lease = state.inner.lock().unwrap();
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            let (result_tx, result_rx) = std::sync::mpsc::channel();
            let reader = state.clone();
            let workspace_id = workspace_id.clone();
            let concurrent = std::thread::spawn(move || {
                eprintln!("packaged phase=concurrent-read begin");
                ready_tx.send(()).unwrap();
                result_tx.send(reader.call("send", json!({"frame":"setup", "command":"sessions.list",
                    "requestId":"concurrent-read", "payload":{"requestId":"concurrent-read", "workspaceId":workspace_id}}))).ok();
            });
            ready_rx.recv().unwrap();
            let blocked = result_rx.recv_timeout(std::time::Duration::from_millis(100));
            drop(lease);
            concurrent.join().unwrap();
            assert!(
                matches!(blocked, Err(std::sync::mpsc::RecvTimeoutError::Timeout)),
                "concurrent native calls must queue instead of being denied"
            );
            let concurrent = result_rx.recv().unwrap()?;
            eprintln!("packaged phase=concurrent-read end");
            assert!(valid_page_read_view("sessions.list", &concurrent));
            assert_eq!(concurrent["sessions"].as_array().unwrap().len(), 1);
            Ok(())
        })();
        let stopped = state.stop();
        let cleanup = std::fs::remove_dir_all(&directory);
        assert!(
            result.is_ok(),
            "{}",
            result.err().map(|e| e.code).unwrap_or("")
        );
        assert!(stopped.is_ok());
        cleanup.unwrap();
    }

    fn provider_setup_fixture() -> Value {
        json!({"requestId":"request1","workspaceId":"workspace1","providerConnectionId":"connection1","profileId":"profile1",
            "apiFamily":"openai-completions","endpoint":"https://example.test/api/v1","locality":"hosted","chat":{"modelId":"vendor/model:version","model":{"contextWindow":8192,"maxOutputTokens":1024}},
            "accountScopeRef":"provider-default","credential":{"kind":"new","secret":"synthetic-setup-value"},
            "expectedConnectionRevision":null,"expectedProfileRevision":null,"expectedEndpointRevision":null})
    }

    #[test]
    fn provider_view_requires_bounded_current_config_revision() {
        let (metadata, _) = setup_metadata(provider_setup_fixture()).ok().unwrap();
        let mut view = json!({
            "requestId":metadata["requestId"], "workspaceId":metadata["workspaceId"],
            "providerConnectionId":metadata["providerConnectionId"], "profileId":metadata["profileId"],
            "apiFamily":metadata["apiFamily"], "locality":metadata["locality"],
            "endpointOrigin":"https://example.test:443", "chat":metadata["chat"],
            "connectionRevision":"c1", "profileRevision":"p1", "endpointRevision":"r1",
            "configRevision":"cfg-0", "credentialState":"stored", "generationReady":false
        });
        assert!(valid_setup_view(&view, &metadata));
        for value in [
            json!(null),
            json!(""),
            json!("bad/id"),
            json!("x".repeat(129)),
        ] {
            view["configRevision"] = value;
            assert!(!valid_setup_view(&view, &metadata));
        }
        view.as_object_mut().unwrap().remove("configRevision");
        assert!(!valid_setup_view(&view, &metadata));
    }

    #[test]
    fn provider_setup_accepts_only_exact_sessionless_public_contract() {
        let payload = provider_setup_fixture();
        let frame = json!({"frame":"setup","command":"provider.configure","requestId":"request1","payload":payload});
        assert!(valid_setup("provider.configure", &frame));
        assert!(!valid_setup("metadata", &frame));
        for (field, value) in [
            ("requestId", json!("different")),
            ("apiFamily", json!("openai-compatible")),
            ("accountScopeRef", json!("other-account")),
            ("locality", json!("loopback")),
            ("credential", json!({"kind":"keep"})),
            ("expectedConnectionRevision", json!("c01")),
            ("expectedProfileRevision", json!("cfg-0")),
            ("expectedEndpointRevision", json!("r9007199254740991")),
            ("chat", json!({"modelId":"vendor/model", "secret":"extra"})),
        ] {
            let mut invalid = frame.clone();
            invalid["payload"][field] = value;
            assert!(!valid_setup("provider.configure", &invalid), "{field}");
        }
        for field in ["displayName", "credentialRef", "sessionId", "endpointRef"] {
            let mut invalid = frame.clone();
            invalid["payload"][field] = json!("extra");
            assert!(!valid_setup("provider.configure", &invalid));
        }
    }

    #[test]
    fn provider_setup_user_model_metadata_has_strict_fields_and_conservative_features() {
        let mut input = provider_setup_fixture();
        input["chat"]["model"] = json!({"contextWindow":8192,"maxOutputTokens":1024});
        assert!(valid_provider_setup(&input, &json!("request1")));
        let (metadata, _) = setup_metadata(input.clone()).ok().unwrap();
        assert_eq!(
            metadata["chat"]["model"],
            json!({"contextWindow":8192,"maxOutputTokens":1024,"reasoning":false,"input":["text"]})
        );
        input["chat"]["model"] =
            json!({"contextWindow":2097152,"maxOutputTokens":1048576,"input":["image"]});
        assert!(valid_provider_setup(&input, &json!("request1")));
        for model in [
            Value::Null,
            json!({}),
            json!({"contextWindow":8192}),
            json!({"contextWindow":8192,"maxOutputTokens":0}),
            json!({"contextWindow":1.5,"maxOutputTokens":1}),
            json!({"contextWindow":9007199254740992u64,"maxOutputTokens":1}),
            json!({"contextWindow":2097153,"maxOutputTokens":1}),
            json!({"contextWindow":2097152,"maxOutputTokens":1048577}),
            json!({"contextWindow":8192,"maxOutputTokens":8193}),
            json!({"contextWindow":8192,"maxOutputTokens":1,"reasoning":"false"}),
            json!({"contextWindow":8192,"maxOutputTokens":1,"input":[]}),
            json!({"contextWindow":8192,"maxOutputTokens":1,"input":["audio"]}),
            json!({"contextWindow":8192,"maxOutputTokens":1,"input":["text","text"]}),
            json!({"contextWindow":8192,"maxOutputTokens":1,"source":"catalog"}),
            json!({"contextWindow":8192,"maxOutputTokens":1,"costKnown":true}),
            json!({"contextWindow":8192,"maxOutputTokens":1,"cost":{"input":0,"output":0}}),
        ] {
            input["chat"]["model"] = model;
            assert!(!valid_provider_setup(&input, &json!("request1")));
        }
    }

    #[test]
    fn provider_setup_endpoint_matches_canonical_contract_and_locality() {
        for (endpoint, locality, accepted) in [
            ("https://example.test/v1", "hosted", true),
            ("http://127.0.0.1:8080/v1", "loopback", true),
            ("http://[::1]:8080/v1", "loopback", true),
            ("https://localhost/v1", "hosted", false),
            ("https://example.test/v1", "loopback", false),
            ("http://example.test/v1", "hosted", false),
            ("https://EXAMPLE.test/v1", "hosted", false),
            ("https://example.test/v1/", "hosted", false),
            ("https://example.test/%2e%2e/v1", "hosted", false),
            ("https://example.test/a//v1", "hosted", false),
            ("https://user@example.test/v1", "hosted", false),
            ("https://example.test/v1?q=x", "hosted", false),
        ] {
            assert_eq!(
                canonical_setup_endpoint(&json!(endpoint), &json!(locality)).is_some(),
                accepted,
                "{endpoint}"
            );
        }
    }

    #[test]
    fn provider_setup_removes_secret_and_rejects_finite_forms_before_transport() {
        let (metadata, secret) = setup_metadata(provider_setup_fixture()).ok().unwrap();
        assert_eq!(metadata["credentialKind"], "new");
        assert!(metadata.get("credential").is_none());
        assert_eq!(secret.unwrap().as_str(), "synthetic-setup-value");
        for value in [
            "synthetic-setup-value",
            "c3ludGhldGljLXNldHVwLXZhbHVl",
            "73796e7468657469632d73657475702d76616c7565",
        ] {
            let mut input = provider_setup_fixture();
            input["chat"]["modelId"] = json!(value);
            assert!(setup_metadata(input).is_err());
        }
        for raw in ["", "bad\nvalue"] {
            let mut input = provider_setup_fixture();
            input["credential"]["secret"] = json!(raw);
            assert!(
                configure_provider(input, |_, _| panic!("invalid setup reached transport"))
                    .is_err()
            );
        }
    }

    #[test]
    fn provider_setup_checks_decoded_fields_before_json_escaping() {
        let mut escaped = provider_setup_fixture();
        escaped["credential"]["secret"] = json!("synthetic-\"quoted-value");
        escaped["chat"]["modelId"] = json!("synthetic-\\\"quoted-value");
        assert!(setup_metadata(escaped).is_err());
        let mut numeric = provider_setup_fixture();
        numeric["credential"]["secret"] = json!("8192");
        assert!(
            setup_metadata(numeric).is_err(),
            "numeric model settings must not carry a credential representation"
        );
    }

    #[test]
    fn provider_setup_transport_loss_preserves_actual_wincred_key() {
        use crate::credentials::{CredentialRef, delete_owned, read_owned};
        use sha2::{Digest, Sha256};
        use windows_sys::Win32::Security::Cryptography::{
            BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
        };
        let _inventory = crate::credentials::fixture_guard();
        let mut id = [0_u8; 32];
        assert!(
            unsafe {
                BCryptGenRandom(
                    std::ptr::null_mut(),
                    id.as_mut_ptr(),
                    32,
                    BCRYPT_USE_SYSTEM_PREFERRED_RNG,
                )
            } >= 0
        );
        let reference = CredentialRef::parse(&format!(
            "splyce-credential:v1:{}",
            id.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ))
        .unwrap();
        struct Cleanup(Option<CredentialRef>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Some(reference) = &self.0 {
                    let _ = delete_owned(reference);
                }
            }
        }
        let cleanup = std::cell::RefCell::new(Cleanup(None));
        let input = provider_setup_fixture();
        let hash: String = Sha256::digest(input["requestId"].as_str().unwrap().as_bytes())
            .iter()
            .take(16)
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let reservation = json!({"recordId":format!("setup:{}:credres", &hash[..32]),"digest":format!("sha256:{}", "a".repeat(64)),"created":true});
        let attempts = std::cell::Cell::new(0);
        let transport = |method: &str, params: Value| {
            assert!(
                !serde_json::to_string(&params)
                    .unwrap()
                    .contains("synthetic-setup-value")
            );
            match method {
                "native.provider.prepare" => {
                    let mut reservation = reservation.clone();
                    reservation["created"] = json!(attempts.get() == 0);
                    attempts.set(attempts.get() + 1);
                    Ok(
                        json!({"state":"prepared","credentialRef":reference.as_str(),"reservation":reservation}),
                    )
                }
                "native.provider.commit" => {
                    cleanup.borrow_mut().0 = Some(reference.clone());
                    assert_eq!(params["credentialRef"], reference.as_str());
                    assert_eq!(
                        read_owned(&reference).unwrap().as_str(),
                        "synthetic-setup-value"
                    );
                    Err(BridgeError::engine())
                }
                _ => panic!("unexpected transport call"),
            }
        };
        for _ in 0..2 {
            assert_eq!(
                configure_provider(input.clone(), transport)
                    .err()
                    .unwrap()
                    .code,
                "SETUP_OUTCOME_UNKNOWN"
            );
            assert_eq!(
                read_owned(&reference).unwrap().as_str(),
                "synthetic-setup-value"
            );
        }
        assert_eq!(attempts.get(), 2);

        let (metadata, _) = setup_metadata(input.clone()).ok().unwrap();
        let view = json!({
            "requestId":metadata["requestId"], "workspaceId":metadata["workspaceId"],
            "providerConnectionId":metadata["providerConnectionId"], "profileId":metadata["profileId"],
            "apiFamily":metadata["apiFamily"], "locality":metadata["locality"],
            "endpointOrigin":"https://example.test:443", "chat":metadata["chat"],
            "connectionRevision":"c1", "profileRevision":"p1", "endpointRevision":"r1",
            "configRevision":"cfg-0", "credentialState":"stored", "generationReady":false
        });
        let mut existing = reservation.clone();
        existing["created"] = json!(false);
        let rejected = configure_provider(input.clone(), |method, _| match method {
            "native.provider.prepare" => Ok(
                json!({"state":"prepared","credentialRef":reference.as_str(),"reservation":existing}),
            ),
            "native.provider.commit" => {
                let winning = configure_provider(input.clone(), |method, _| match method {
                    "native.provider.prepare" => Ok(
                        json!({"state":"prepared","credentialRef":reference.as_str(),"reservation":existing}),
                    ),
                    "native.provider.commit" => Ok(json!({})),
                    "native.provider.read" => Ok(
                        json!({"state":"committed","credentialRef":reference.as_str(),"view":view}),
                    ),
                    _ => panic!("unexpected transport call"),
                });
                assert!(winning.is_ok());
                Err(BridgeError::setup("SETUP_STALE_REVISION"))
            }
            _ => panic!("unexpected transport call"),
        });
        assert_eq!(rejected.err().unwrap().code, "SETUP_STALE_REVISION");
        assert_eq!(
            read_owned(&reference).unwrap().as_str(),
            "synthetic-setup-value"
        );
        let retry = configure_provider(input, |method, _| match method {
            "native.provider.prepare" => {
                Ok(json!({"state":"replayed","credentialRef":reference.as_str(),"view":view}))
            }
            "native.provider.read" => {
                Ok(json!({"state":"committed","credentialRef":reference.as_str(),"view":view}))
            }
            _ => panic!("unexpected transport call"),
        });
        assert!(retry.is_ok());
    }

    #[test]
    fn provider_setup_existing_secret_smuggling_and_error_correlation_stay_native() {
        let _inventory = crate::credentials::fixture_guard();
        use crate::credentials::{delete_owned, write_generated};
        let reference = write_generated("synthetic-existing-setup-key").unwrap();
        let mut input = provider_setup_fixture();
        input["credential"] = json!({"kind":"keep"});
        input["expectedConnectionRevision"] = json!("c1");
        input["chat"]["modelId"] = json!("synthetic-existing-setup-key");
        let result = configure_provider(input, |_, _| panic!("existing secret reached Node"));
        delete_owned(&reference).unwrap();
        assert_eq!(result.err().unwrap().code, "SETUP_INVALID");
        let mut frame =
            json!({"requestId":"synthetic-setup-value","payload":provider_setup_fixture()});
        assert!(setup_correlation(&frame).is_none());
        frame["requestId"] = json!("73796e7468657469632d73657475702d76616c7565");
        assert!(setup_correlation(&frame).is_none());
        frame["requestId"] = json!("safe-request");
        assert_eq!(setup_correlation(&frame), Some("safe-request".into()));
    }

    struct SetupSourcePipe {
        child: std::process::Child,
        sequence: u64,
        frames: Vec<Value>,
    }

    impl SetupSourcePipe {
        fn start(directory: &Path) -> Self {
            Self::start_entry(directory, "packages/splyce-pi/src/engine-host.mjs")
        }

        fn start_entry(directory: &Path, entry: &str) -> Self {
            use std::os::windows::process::CommandExt;
            use std::process::{Command, Stdio};
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(3)
                .unwrap();
            let child = Command::new(root.join("apps/desktop/src-tauri/resources/engine/node.exe"))
                .arg(root.join(entry))
                .env("NODE_NO_WARNINGS", "1")
                .creation_flags(0x0800_0000)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut pipe = Self {
                child,
                sequence: 0,
                frames: Vec::new(),
            };
            assert!(
                pipe.call_with_id(
                    "native-bootstrap",
                    "native.bootstrap",
                    json!({"appDataDir":directory})
                )
                .is_ok()
            );
            pipe
        }

        fn call_with_id(
            &mut self,
            id: &str,
            method: &str,
            params: Value,
        ) -> Result<Value, BridgeError> {
            use std::io::{Read, Write};
            let request = json!({"id":id,"method":method,"params":params});
            self.frames.push(request.clone());
            let bytes = serde_json::to_vec(&request).unwrap();
            let input = self.child.stdin.as_mut().unwrap();
            input
                .write_all(&(bytes.len() as u32).to_be_bytes())
                .unwrap();
            input.write_all(&bytes).unwrap();
            input.flush().unwrap();
            let output = self.child.stdout.as_mut().unwrap();
            let mut header = [0; 4];
            output.read_exact(&mut header).unwrap();
            let length = u32::from_be_bytes(header) as usize;
            assert!((1..262144).contains(&length));
            let mut bytes = vec![0; length];
            output.read_exact(&mut bytes).unwrap();
            let reply: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(reply["id"], id);
            self.frames.push(reply.clone());
            if reply["ok"] == true {
                return Ok(reply["value"].clone());
            }
            let code = match reply["error"]["code"].as_str() {
                Some("SETUP_REQUEST_CONFLICT") => "SETUP_REQUEST_CONFLICT",
                Some("SETUP_STALE_REVISION" | "ENTITY_STALE_REVISION") => "SETUP_STALE_REVISION",
                Some("SETUP_WORKSPACE_UNAVAILABLE") => "SETUP_WORKSPACE_UNAVAILABLE",
                Some("SETUP_INVALID") => "SETUP_INVALID",
                Some("SETUP_UNAVAILABLE") => "SETUP_UNAVAILABLE",
                Some("SETUP_MODEL_METADATA_REQUIRED") => "SETUP_MODEL_METADATA_REQUIRED",
                _ => "SETUP_OUTCOME_UNKNOWN",
            };
            Err(BridgeError::setup(code))
        }

        fn call(&mut self, method: &str, params: Value) -> Result<Value, BridgeError> {
            self.sequence += 1;
            self.call_with_id(&format!("fixture{}", self.sequence), method, params)
        }

        fn delete_latest_connection(directory: &Path, scope_id: &str) {
            use std::os::windows::process::CommandExt;
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(3)
                .unwrap();
            let store_url =
                tauri::Url::from_file_path(root.join("packages/splyce-pi/dist/store.js")).unwrap();
            let script = format!(
                "import {{Store}} from {}; const s=Store.open(process.argv[1]);const r=s.readSetupState(process.argv[2]).records.findLast(x=>x.kind==='providerConnection');s.noteDeletion(r.record.recordId);s.close();",
                serde_json::to_string(store_url.as_str()).unwrap()
            );
            let result = std::process::Command::new(
                root.join("apps/desktop/src-tauri/resources/engine/node.exe"),
            )
            .args(["--input-type=module", "--eval", &script])
            .arg(directory.join("app-data/splyce/store.db"))
            .arg(scope_id)
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }

        fn verify_model_descriptor(
            directory: &Path,
            scope_id: &str,
            model_id: &str,
            expected: Value,
        ) {
            use std::os::windows::process::CommandExt;
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(3)
                .unwrap();
            let store_url =
                tauri::Url::from_file_path(root.join("packages/splyce-pi/dist/store.js")).unwrap();
            let catalog_url = tauri::Url::from_file_path(
                root.join("vendor/pi/packages/ai/src/providers/data/openai.json"),
            )
            .unwrap();
            let script = format!(
                r#"import {{Store}} from {};import assert from 'node:assert/strict';import {{createHash}} from 'node:crypto';import {{readFileSync}} from 'node:fs';
const s=Store.open(process.argv[1]);const rows=s.readSetupState(process.argv[2]).records;
const p=rows.findLast(x=>x.kind==='profileSnapshot').record;
const a=rows.find(x=>x.kind==='artifact'&&p.sourceIds.includes(x.record.recordId)&&x.record.mediaType==='application/vnd.splyce.model-descriptor+json')?.record;
const expected=JSON.parse(process.argv[4]);if(expected.source==='catalog')expected.catalogVersion='openai-v1-'+createHash('sha256').update(JSON.stringify(JSON.parse(readFileSync(new URL({}),'utf8')))).digest('hex');
assert.ok(a);assert.equal(a.role,'chat');assert.equal(a.modelId,process.argv[3]);assert.deepEqual(a.descriptor,expected);
assert.equal(a.digest,'sha256:'+createHash('sha256').update(JSON.stringify(a.descriptor)).digest('hex'));
assert.equal(a.byteLength,Buffer.byteLength(JSON.stringify(a.descriptor)));assert.ok(!Object.hasOwn(a.descriptor,'cost'));
assert.ok(p.bindings.every(b=>!Object.hasOwn(b,'modelDescriptor')));s.close();"#,
                serde_json::to_string(store_url.as_str()).unwrap(),
                serde_json::to_string(catalog_url.as_str()).unwrap()
            );
            let result = std::process::Command::new(
                root.join("apps/desktop/src-tauri/resources/engine/node.exe"),
            )
            .args(["--input-type=module", "--eval", &script])
            .arg(directory.join("app-data/splyce/store.db"))
            .arg(scope_id)
            .arg(model_id)
            .arg(serde_json::to_string(&expected).unwrap())
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }

    impl Drop for SetupSourcePipe {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    fn provider_setup_corrupt_inventory_blocks_source_and_bundled_host_before_save() {
        use crate::credentials::{delete_owned, write_generated};
        use windows_sys::Win32::Security::Credentials::{
            CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredWriteW,
        };
        let _inventory = crate::credentials::fixture_guard();
        let reference = write_generated("synthetic-inventory-fixture").unwrap();
        struct Cleanup(crate::credentials::CredentialRef);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                assert!(matches!(
                    delete_owned(&self.0),
                    Ok(()) | Err(crate::credentials::CredentialError::NotFound)
                ));
            }
        }
        let cleanup = Cleanup(reference);
        let mut target: Vec<u16> = format!(
            "Splyce/credentials/v1/{}",
            cleanup
                .0
                .as_str()
                .strip_prefix("splyce-credential:v1:")
                .unwrap()
        )
        .encode_utf16()
        .chain(Some(0))
        .collect();
        let mut invalid = [0xff_u8];
        let corrupt = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            CredentialBlobSize: invalid.len() as u32,
            CredentialBlob: invalid.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        assert_ne!(unsafe { CredWriteW(&corrupt, 0) }, 0);
        for entry in [
            "packages/splyce-pi/src/engine-host.mjs",
            "apps/desktop/src-tauri/resources/engine/host.mjs",
        ] {
            let directory = std::env::temp_dir().join(format!(
                "splyce-inventory-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&directory).unwrap();
            let mut source = SetupSourcePipe::start_entry(&directory.join("app-data"), entry);
            let spec: Value = serde_json::from_str(PROTOCOL).unwrap();
            let handshake = source
                .call(
                    "handshake",
                    json!({"protocolVersion":spec["protocolVersion"]}),
                )
                .ok()
                .unwrap();
            assert!(valid_handshake(&handshake, &spec));
            assert_eq!(handshake["readiness"]["state"], "ready");
            assert_eq!(handshake["readiness"]["ports"]["provider"], false);
            let admitted = crate::workspace::qualify_directory(&directory).unwrap();
            let identity = admitted.identity();
            let workspace = source.call("native.workspace.admit", json!({"canonicalPath":admitted.path(),"volumeSerial":identity.volume_serial.to_string(),"fileId":identity.file_id.to_string()})).ok().unwrap();
            let mut input = provider_setup_fixture();
            input["workspaceId"] = workspace["workspaceId"].clone();
            let (metadata, _) = setup_metadata(input.clone()).ok().unwrap();
            let prepared = source
                .call("native.provider.prepare", metadata)
                .ok()
                .unwrap();
            assert_eq!(prepared["state"], "prepared");
            let _prepared_cleanup = Cleanup(
                crate::credentials::CredentialRef::parse(
                    prepared["credentialRef"].as_str().unwrap(),
                )
                .unwrap(),
            );
            let before = source.frames.len();
            let source = std::cell::RefCell::new(source);
            let secret = input["credential"]["secret"].as_str().unwrap();
            let count = crate::credentials::count_fixture_value(secret).unwrap();
            let error = configure_provider(input.clone(), |method, params| {
                source.borrow_mut().call(method, params)
            })
            .err()
            .unwrap();
            assert_eq!(error.code, "SETUP_CREDENTIAL_INVENTORY_UNAVAILABLE");
            assert_eq!(
                error.message,
                "Windows credential inventory could not be validated"
            );
            assert_eq!(
                source.borrow().frames.len(),
                before,
                "failed inventory must stop before Node or credential creation"
            );
            assert_eq!(
                crate::credentials::count_fixture_value(secret).unwrap(),
                count
            );
            let encoded = serde_json::to_string(&error).unwrap();
            assert!(!encoded.contains(secret));
            assert!(!encoded.contains("Splyce/credentials/"));
            eprintln!("{entry}: {encoded}");
            drop(source);
            drop(admitted);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn provider_setup_missing_or_invalid_model_writes_no_actual_credential() {
        let _inventory = crate::credentials::fixture_guard();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "splyce-model-metadata-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let mut source = SetupSourcePipe::start(&directory.join("app-data"));
        let admitted = crate::workspace::qualify_directory(&directory).unwrap();
        let identity = admitted.identity();
        let workspace = source.call("native.workspace.admit", json!({"canonicalPath":admitted.path(),"volumeSerial":identity.volume_serial.to_string(),"fileId":identity.file_id.to_string()})).ok().unwrap();
        let source = std::cell::RefCell::new(source);
        let secret = format!("missing-model-proof-{nonce}");
        let mut input = provider_setup_fixture();
        input["workspaceId"] = workspace["workspaceId"].clone();
        input["credential"]["secret"] = json!(secret);
        input["chat"].as_object_mut().unwrap().remove("model");
        assert_eq!(crate::credentials::count_fixture_value(&secret).unwrap(), 0);
        let result = configure_provider(input.clone(), |method, params| {
            source.borrow_mut().call(method, params)
        });
        assert_eq!(result.err().unwrap().code, "SETUP_MODEL_METADATA_REQUIRED");
        assert_eq!(crate::credentials::count_fixture_value(&secret).unwrap(), 0);
        for model in [
            json!({"contextWindow":0,"maxOutputTokens":1}),
            json!({"contextWindow":8192,"maxOutputTokens":8193}),
            json!({"contextWindow":8192,"maxOutputTokens":1,"costKnown":true}),
        ] {
            input["chat"]["model"] = model;
            let result = configure_provider(input.clone(), |_, _| {
                panic!("invalid model metadata reached Node")
            });
            assert_eq!(result.err().unwrap().code, "SETUP_INVALID");
            assert_eq!(crate::credentials::count_fixture_value(&secret).unwrap(), 0);
        }
        drop(source);
        drop(admitted);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn provider_setup_real_store_wincred_source_pipe_replay_keep_rotation_and_privacy() {
        let _inventory = crate::credentials::fixture_guard();
        use crate::credentials::{CredentialRef, delete_owned, read_owned};
        let directory = std::env::temp_dir().join(format!(
            "splyce-provider-setup-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let mut source = SetupSourcePipe::start(&directory.join("app-data"));
        let admitted = crate::workspace::qualify_directory(&directory).unwrap();
        let identity = admitted.identity();
        let workspace = source.call("native.workspace.admit", json!({"canonicalPath":admitted.path(),"volumeSerial":identity.volume_serial.to_string(),"fileId":identity.file_id.to_string()})).ok().unwrap();
        let source = std::cell::RefCell::new(source);
        let references = std::cell::RefCell::new(Vec::new());
        let interrupted = std::cell::RefCell::new(None);
        struct Cleanup<'a>(
            &'a std::cell::RefCell<Vec<CredentialRef>>,
            &'a std::cell::RefCell<Option<CredentialRef>>,
        );
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let mut unique = Vec::new();
                for reference in self.0.borrow().iter().chain(self.1.borrow().iter()) {
                    if !unique.contains(reference) {
                        let _ = delete_owned(reference);
                        unique.push(reference.clone());
                    }
                }
            }
        }
        let _cleanup = Cleanup(&references, &interrupted);
        let transport = |method: &str, params: Value| {
            if method == "native.provider.commit" {
                references.borrow_mut().push(
                    CredentialRef::parse(params["credentialRef"].as_str().unwrap())
                        .ok()
                        .unwrap(),
                );
            }
            source.borrow_mut().call(method, params)
        };
        let mut input = provider_setup_fixture();
        input["workspaceId"] = workspace["workspaceId"].clone();
        let first_attempt = configure_provider(input.clone(), |method, params| {
            if method == "native.provider.commit" {
                *interrupted.borrow_mut() =
                    Some(CredentialRef::parse(params["credentialRef"].as_str().unwrap()).unwrap());
                return Err(BridgeError::engine());
            }
            source.borrow_mut().call(method, params)
        });
        assert_eq!(first_attempt.err().unwrap().code, "SETUP_OUTCOME_UNKNOWN");
        let first = configure_provider(input.clone(), transport).ok().unwrap();
        assert!(interrupted.borrow().as_ref() == references.borrow().first());
        assert_eq!(first["connectionRevision"], "c1");
        assert_eq!(first["profileRevision"], "p1");
        assert_eq!(first["endpointRevision"], "r1");
        assert_eq!(first["endpointOrigin"], "https://example.test:443");
        assert_eq!(
            first["chat"]["model"],
            json!({"contextWindow":8192,"maxOutputTokens":1024,"reasoning":false,"input":["text"]})
        );
        SetupSourcePipe::verify_model_descriptor(
            &directory,
            workspace["workspaceId"].as_str().unwrap(),
            "vendor/model:version",
            json!({"source":"user","contextWindow":8192,"maxOutputTokens":1024,"reasoning":false,"input":["text"],"costKnown":false}),
        );
        assert!(
            !serde_json::to_string(&first)
                .unwrap()
                .contains("splyce-credential")
        );
        let replay = configure_provider(input.clone(), transport).ok().unwrap();
        assert_eq!(first, replay);
        assert_eq!(
            references.borrow().len(),
            1,
            "replay must not mint or commit another key"
        );
        let mut different = input.clone();
        different["credential"]["secret"] = json!("different-synthetic-value");
        assert_eq!(
            configure_provider(different, transport).err().unwrap().code,
            "SETUP_REQUEST_CONFLICT"
        );
        let mut keep = input.clone();
        keep["requestId"] = json!("keep-request");
        keep["credential"] = json!({"kind":"keep"});
        keep["expectedConnectionRevision"] = json!("c1");
        keep["expectedProfileRevision"] = json!("p1");
        keep["expectedEndpointRevision"] = json!("r1");
        let second = configure_provider(keep.clone(), transport).ok().unwrap();
        assert_eq!(second["connectionRevision"], "c2");
        assert!(references.borrow()[0] == references.borrow()[1]);
        assert_eq!(
            configure_provider(input, transport).err().unwrap().code,
            "SETUP_STALE_REVISION"
        );
        keep["requestId"] = json!("rotation-request");
        keep["credential"] = json!({"kind":"new","secret":"synthetic-rotation-value"});
        keep["expectedConnectionRevision"] = json!("c2");
        keep["expectedProfileRevision"] = json!("p2");
        keep["expectedEndpointRevision"] = json!("r2");
        let rotated = configure_provider(keep.clone(), transport).ok().unwrap();
        assert_eq!(rotated["connectionRevision"], "c3");
        assert!(references.borrow()[0] != references.borrow()[2]);
        assert!(
            read_owned(&references.borrow()[0]).is_ok(),
            "rotation retains referenced historical key"
        );
        keep["requestId"] = json!("lost-read-request");
        keep["expectedConnectionRevision"] = json!("c3");
        keep["expectedProfileRevision"] = json!("p3");
        keep["expectedEndpointRevision"] = json!("r3");
        let lost = configure_provider(keep.clone(), |method, params| {
            if method == "native.provider.read" {
                return Err(BridgeError::engine());
            }
            transport(method, params)
        });
        assert_eq!(lost.err().unwrap().code, "SETUP_OUTCOME_UNKNOWN");
        assert!(
            read_owned(references.borrow().last().unwrap()).is_ok(),
            "lost read must retain the actually committed key"
        );
        let recovered = configure_provider(keep.clone(), transport).ok().unwrap();
        assert_eq!(recovered["connectionRevision"], "c4");
        assert_eq!(
            references.borrow().len(),
            4,
            "recovery reuses committed key without another write"
        );
        SetupSourcePipe::delete_latest_connection(
            &directory,
            workspace["workspaceId"].as_str().unwrap(),
        );
        keep["requestId"] = json!("deleted-latest-request");
        keep["expectedConnectionRevision"] = json!("c3");
        keep["expectedProfileRevision"] = json!("p4");
        keep["expectedEndpointRevision"] = json!("r4");
        assert_eq!(
            configure_provider(keep, transport).err().unwrap().code,
            "SETUP_STALE_REVISION"
        );
        assert_eq!(
            references.borrow().len(),
            4,
            "deleted newest connection must not revive c3 or mint a new key"
        );
        let mut catalog = provider_setup_fixture();
        catalog["workspaceId"] = workspace["workspaceId"].clone();
        catalog["requestId"] = json!("catalog-request");
        catalog["providerConnectionId"] = json!("catalog-connection");
        catalog["profileId"] = json!("catalog-profile");
        catalog["apiFamily"] = json!("openai-responses");
        catalog["endpoint"] = json!("https://api.openai.com/v1");
        catalog["chat"] = json!({"modelId":"gpt-4"});
        catalog["credential"]["secret"] = json!("synthetic-catalog-value");
        let known = configure_provider(catalog.clone(), transport).ok().unwrap();
        assert_eq!(
            known["chat"]["model"],
            json!({"contextWindow":8192,"maxOutputTokens":8192,"reasoning":false,"input":["text"]})
        );
        SetupSourcePipe::verify_model_descriptor(
            &directory,
            workspace["workspaceId"].as_str().unwrap(),
            "gpt-4",
            json!({"source":"catalog","contextWindow":8192,"maxOutputTokens":8192,"reasoning":false,"input":["text"],"costKnown":false}),
        );
        assert_eq!(configure_provider(catalog, transport).ok().unwrap(), known);
        assert_eq!(
            references.borrow().len(),
            5,
            "catalog replay must reuse the actual stored key"
        );
        let frames = serde_json::to_string(&source.borrow().frames).unwrap();
        for secret in [
            "synthetic-setup-value",
            "synthetic-rotation-value",
            "synthetic-catalog-value",
        ] {
            let secret = crate::credentials::SecretBuffer::from_string(secret.to_owned()).unwrap();
            assert!(!crate::credentials::contains_secret_form(&frames, &secret));
        }
        assert_eq!(
            source
                .borrow_mut()
                .call("handshake", json!({"protocolVersion":2}))
                .ok()
                .unwrap()["readiness"]["ports"]["generation"],
            false
        );
        drop(source);
        drop(admitted);
        std::fs::remove_dir_all(directory).unwrap();
    }

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
    fn model_catalog_fixture_and_guards() {
        let fixture: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../tests/fixtures/contracts/models-list.json"
        )))
        .unwrap();
        let frame = json!({"frame":"setup", "command":"models.list", "requestId":fixture["request"]["requestId"], "payload":fixture["request"]});
        assert!(valid_setup("models.list", &frame));
        let mut bad = frame.clone();
        bad["payload"].as_object_mut().unwrap().remove("profileId");
        assert!(!valid_setup("models.list", &bad));
        assert!(valid_model_catalog_view(&fixture["result"]));
        let mut bad = fixture["result"].clone();
        bad["models"][0]["modelId"] = json!("bad\u{200b}");
        assert!(!valid_model_catalog_view(&bad));
        bad = fixture["result"].clone();
        let duplicate = bad["models"][0].clone();
        bad["models"].as_array_mut().unwrap().push(duplicate);
        assert!(!valid_model_catalog_view(&bad));
    }

    #[test]
    fn setup_read_validates_extended_profile_metadata() {
        let view = json!({"configRevision":"c1","selectedProfileId":"p1","profiles":[{
            "profileId":"p1","profileRevision":"p1","apiFamily":"openai-completions",
            "modelId":"model","endpointOrigin":"https://example.test","credential":"configured",
            "providerConnectionId":"connection1","connectionRevision":"c1","endpointRevision":"r1",
            "endpoint":"https://example.test/v1","locality":"hosted",
            "model":{"contextWindow":8192,"maxOutputTokens":1024,"reasoning":false,"input":["text","image"]}
        }]});
        assert!(valid_setup_read_view(&view));
        let mut bad = view.clone();
        bad["profiles"][0]["endpoint"] = json!("https://other.test/v1");
        assert!(!valid_setup_read_view(&bad));
        bad = view.clone();
        bad["profiles"][0]["model"]["input"] = json!(["text", "text"]);
        assert!(!valid_setup_read_view(&bad));
        bad = view.clone();
        bad["profiles"][0]
            .as_object_mut()
            .unwrap()
            .remove("endpointRevision");
        assert!(!valid_setup_read_view(&bad));
    }

    fn page_read_fixture() -> Vec<Value> {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../tests/fixtures/contracts/page-reads.json"
        )))
        .unwrap()
    }

    #[test]
    fn permission_modes_require_strict_requests_and_matching_results() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../tests/fixtures/contracts/permission-modes.json"
        )))
        .unwrap();
        for case in fixtures {
            let op = case["op"].as_str().unwrap();
            let request = &case["request"];
            let result = &case["result"];
            let frame = json!({"frame":"setup", "command":op, "requestId":request["requestId"], "payload":request});
            assert!(valid_setup(op, &frame));
            assert!(valid_permission_result(result, request));
            assert!(!valid_setup("unknown", &frame));
            if op == "permission.read" {
                let mut resume = frame.clone();
                resume["command"] = json!("session.resume");
                assert!(valid_setup("session.resume", &resume));
                resume["payload"]["extra"] = json!(true);
                assert!(!valid_setup("session.resume", &resume));
            }
            for field in request.as_object().unwrap().keys() {
                let mut missing = frame.clone();
                missing["payload"].as_object_mut().unwrap().remove(field);
                assert!(!valid_setup(op, &missing));
                for value in [
                    json!(null),
                    json!(""),
                    json!("bad/id"),
                    json!("bad\\id"),
                    json!("bad id"),
                    json!("bad\u{200b}id"),
                    json!("λ".repeat(65)),
                    json!("x".repeat(129)),
                ] {
                    let mut invalid = frame.clone();
                    invalid["payload"][field] = value;
                    assert!(!valid_setup(op, &invalid), "{op}: {field}");
                }
            }
            let mut mismatch = frame.clone();
            mismatch["payload"]["requestId"] = json!("other");
            assert!(!valid_setup(op, &mismatch));
            for field in ["grantIds", "approvedBy", "path", "secret", "extra"] {
                let mut invalid = frame.clone();
                invalid["payload"][field] = json!("untrusted");
                assert!(!valid_setup(op, &invalid));
                let mut invalid = result.clone();
                invalid[field] = json!("untrusted");
                assert!(!valid_permission_result(&invalid, request));
            }
            for field in ["workspaceId", "sessionId"] {
                let mut invalid = result.clone();
                invalid[field] = json!("other");
                assert!(!valid_permission_result(&invalid, request));
            }
            for mode in ["accept-edits", "plan", "unknown"] {
                let mut invalid = frame.clone();
                invalid["payload"]["mode"] = json!(mode);
                assert!(!valid_setup(op, &invalid));
                let mut invalid = result.clone();
                invalid["mode"] = json!(mode);
                assert!(!valid_permission_result(&invalid, request));
            }
        }
    }

    #[test]
    fn page_reads_require_strict_sessionless_requests() {
        for case in page_read_fixture() {
            let op = case["op"].as_str().unwrap();
            let frame = json!({"frame":"setup", "command":op, "requestId":case["request"]["requestId"], "payload":case["request"]});
            assert!(valid_setup(op, &frame), "{op}");
            assert!(!valid_setup("unknown", &frame));
            for field in ["path", "credentialRef", "sessionId", "extra"] {
                let mut invalid = frame.clone();
                invalid["payload"][field] = json!("private");
                assert!(!valid_setup(op, &invalid), "{op}: {field}");
                let mut invalid = frame.clone();
                invalid[field] = json!("private");
                assert!(!valid_setup(op, &invalid));
            }
            for field in ["requestId", "workspaceId"] {
                for id in ["", "bad/id", "bad\\id", "bad id", "bad\n", &"x".repeat(129)] {
                    let mut invalid = frame.clone();
                    invalid["payload"][field] = json!(id);
                    assert!(!valid_setup(op, &invalid), "{op}: {field}");
                }
                let mut missing = frame.clone();
                missing["payload"].as_object_mut().unwrap().remove(field);
                assert!(!valid_setup(op, &missing));
            }
            let mut mismatch = frame.clone();
            mismatch["payload"]["requestId"] = json!("other");
            assert!(!valid_setup(op, &mismatch));
            if op == "memory.search" {
                for query in [
                    json!(""),
                    json!("   "),
                    json!("x\n"),
                    json!("x\u{0085}"),
                    json!("x".repeat(1025)),
                    json!("é".repeat(513)),
                    json!(null),
                    json!(1),
                ] {
                    let mut invalid = frame.clone();
                    invalid["payload"]["query"] = query;
                    assert!(!valid_setup(op, &invalid));
                }
                let mut boundary = frame.clone();
                boundary["payload"]["query"] = json!("é".repeat(512));
                assert!(valid_setup(op, &boundary));
                boundary["payload"]["query"] = json!(" project ");
                assert!(valid_setup(op, &boundary));
            }
        }
    }

    #[test]
    fn page_reads_validate_shared_results_and_reject_private_or_invalid_rows() {
        for case in page_read_fixture() {
            let op = case["op"].as_str().unwrap();
            let view = &case["result"];
            assert!(valid_page_read_view(op, view), "{op}");
            for field in ["path", "credentialRef", "extra"] {
                let mut invalid = view.clone();
                invalid[field] = json!("private");
                assert!(!valid_page_read_view(op, &invalid));
            }
            if op == "usage.read" {
                for key in ["inputTokens", "outputTokens", "costUsd"] {
                    let mut invalid = view.clone();
                    invalid[key] = json!(0);
                    assert!(!valid_page_read_view(op, &invalid));
                }
                for key in ["sessionCount", "runCount"] {
                    for count in [
                        json!(-1),
                        json!(0.5),
                        json!(9_007_199_254_740_992_u64),
                        json!(null),
                    ] {
                        let mut invalid = view.clone();
                        invalid[key] = count;
                        assert!(!valid_page_read_view(op, &invalid));
                    }
                }
                let mut invalid = view.clone();
                invalid["semantics"] = json!("measured");
                assert!(!valid_page_read_view(op, &invalid));
                continue;
            }
            let key = if op == "sessions.list" {
                "sessions"
            } else {
                "entries"
            };
            let row = &view[key][0];
            for field in ["path", "credentialRef", "extra"] {
                let mut invalid = view.clone();
                invalid[key][0][field] = json!("private");
                assert!(!valid_page_read_view(op, &invalid));
            }
            for field in row.as_object().unwrap().keys() {
                let mut invalid = view.clone();
                invalid[key][0].as_object_mut().unwrap().remove(field);
                assert!(!valid_page_read_view(op, &invalid), "{op}: missing {field}");
            }
            for date in [
                "2026-02-29T00:00:00.000Z",
                "2026-04-31T00:00:00.000Z",
                "2026-10-28T24:00:00.000Z",
                "2026-10-28T00:60:00.000Z",
                "2026-10-28T00:00:60.000Z",
                "2026-10-28T00:00:00Z",
                "2026-10-28T00:00:00.000+00:00",
                "private",
            ] {
                let mut invalid = view.clone();
                invalid[key][0]["createdAt"] = json!(date);
                assert!(!valid_page_read_view(op, &invalid));
            }
            let mut duplicate = view.clone();
            duplicate[key].as_array_mut().unwrap().push(row.clone());
            assert!(!valid_page_read_view(op, &duplicate));
            let limit = if op == "memory.search" { 50 } else { 100 };
            let id_key = if op == "sessions.list" {
                "sessionId"
            } else {
                "observationId"
            };
            let mut bounded = view.clone();
            bounded[key] = Value::Array(
                (0..limit)
                    .map(|index| {
                        let mut row = row.clone();
                        row[id_key] = json!(format!("row-{index}"));
                        row
                    })
                    .collect(),
            );
            assert!(valid_page_read_view(op, &bounded));
            let mut extra_row = row.clone();
            extra_row[id_key] = json!("overflow");
            bounded[key].as_array_mut().unwrap().push(extra_row);
            assert!(!valid_page_read_view(op, &bounded));
            let mut empty = view.clone();
            empty[key] = json!([]);
            assert!(valid_page_read_view(op, &empty));
            assert!(!valid_page_read_view(op, &json!(null)));
            assert!(!valid_page_read_view(op, &json!({"error":"unavailable"})));
            if op == "sessions.list" {
                for state in [
                    "idle",
                    "pending",
                    "running",
                    "completed",
                    "failed",
                    "canceled",
                    "uncertain",
                ] {
                    let mut valid = view.clone();
                    valid[key][0]["state"] = json!(state);
                    valid[key][0]["branchAnchorId"] = Value::Null;
                    assert!(valid_page_read_view(op, &valid));
                }
                let mut invalid = view.clone();
                invalid[key][0]["state"] = json!("unknown");
                assert!(!valid_page_read_view(op, &invalid));
            } else {
                for count in [json!(-1), json!(0.5), json!(9_007_199_254_740_992_u64)] {
                    let mut invalid = view.clone();
                    invalid[key][0]["sourceCount"] = count;
                    assert!(!valid_page_read_view(op, &invalid));
                }
            }
        }
        assert!(page_timestamp(&json!("2024-02-29T00:00:00.000Z")));
        assert!(!valid_page_read_view("unknown", &json!({})));
    }

    #[test]
    fn page_read_errors_allowlist_codes_and_sanitize_engine_messages() {
        for (input, expected) in [
            (Some("PAGE_READ_INVALID"), "PAGE_READ_INVALID"),
            (Some("PAGE_READ_UNAVAILABLE"), "PAGE_READ_UNAVAILABLE"),
            (Some("private-error"), "PAGE_READ_UNAVAILABLE"),
            (None, "PAGE_READ_UNAVAILABLE"),
        ] {
            let mut error = BridgeError::page_read(input);
            error.correlation_id = "page-read-1".into();
            let wire = serde_json::to_value(error).unwrap();
            assert_eq!(
                wire,
                json!({"code":expected,"message":"Page data unavailable","correlationId":"page-read-1","retryable":false})
            );
        }
    }

    #[test]
    fn setup_read_rejects_authority_and_private_result_fields() {
        let frame = json!({"frame":"setup", "command":"setup.read", "requestId":"read1", "payload":{"requestId":"read1", "workspaceId":"workspace1"}});
        assert!(valid_setup("setup.read", &frame));
        for field in ["path", "credentialRef", "sessionId", "extra"] {
            let mut invalid = frame.clone();
            invalid["payload"][field] = json!("untrusted");
            assert!(!valid_setup("setup.read", &invalid));
        }
        let mut mismatched = frame.clone();
        mismatched["payload"]["requestId"] = json!("other");
        assert!(!valid_setup("setup.read", &mismatched));
        let view = json!({"configRevision":"cfg-0", "selectedProfileId":"profile1", "profiles":[{"profileId":"profile1","profileRevision":"p1","apiFamily":"openai-completions","modelId":"org/model","endpointOrigin":"https://example.test","credential":"configured"}]});
        assert!(valid_setup_read_view(&view));
        for field in ["credentialRef", "path", "extra"] {
            let mut invalid = view.clone();
            invalid["profiles"][0][field] = json!("private");
            assert!(!valid_setup_read_view(&invalid));
        }
        for origin in [
            "https://example.test/",
            "https://user@example.test",
            "https://example.test/path",
            "https://example.test?q=private",
        ] {
            let mut invalid = view.clone();
            invalid["profiles"][0]["endpointOrigin"] = json!(origin);
            assert!(!valid_setup_read_view(&invalid));
        }
        let mut duplicate = view.clone();
        duplicate["profiles"]
            .as_array_mut()
            .unwrap()
            .push(view["profiles"][0].clone());
        assert!(!valid_setup_read_view(&duplicate));
        let mut unknown = view.clone();
        unknown["selectedProfileId"] = json!("unknown");
        assert!(!valid_setup_read_view(&unknown));
        assert!(valid_setup_read_view(
            &json!({"configRevision":"cfg-0","selectedProfileId":null,"profiles":[]})
        ));
    }

    #[test]
    fn selection_and_session_setup_require_exact_payloads_without_authority() {
        for op in ["profile.select", "session.start"] {
            let mut payload = json!({
                "requestId":"request1", "workspaceId":"workspace1",
                "profileId":"profile1", "expectedConfigRevision":"cfg-0"
            });
            if op == "profile.select" {
                payload["expectedProfileRevision"] = json!("p1");
            }
            let valid =
                json!({"frame":"setup","command":op,"requestId":"request1","payload":payload});
            assert!(valid_setup(op, &valid));
            assert!(!valid_setup("other", &valid));
            for field in payload.as_object().unwrap().keys() {
                for value in [
                    json!(null),
                    json!(""),
                    json!("bad/id"),
                    json!("bad\nvalue"),
                    json!("x".repeat(129)),
                ] {
                    let mut invalid = valid.clone();
                    invalid["payload"][field] = value;
                    assert!(!valid_setup(op, &invalid), "{op}: {field}");
                }
                let mut missing = valid.clone();
                missing["payload"].as_object_mut().unwrap().remove(field);
                assert!(!valid_setup(op, &missing));
            }
            let mut mismatched = valid.clone();
            mismatched["payload"]["requestId"] = json!("other-request");
            assert!(!valid_setup(op, &mismatched));
            for field in [
                "sessionId",
                "scopeId",
                "grantIds",
                "credentialRef",
                "path",
                "extra",
            ] {
                let mut invalid = valid.clone();
                invalid["payload"][field] = json!("untrusted");
                assert!(!valid_setup(op, &invalid));
                invalid = valid.clone();
                invalid[field] = json!("untrusted");
                assert!(!valid_setup(op, &invalid));
            }
            if op == "session.start" {
                let mut invalid = valid.clone();
                invalid["payload"]["expectedProfileRevision"] = json!("p1");
                assert!(!valid_setup(op, &invalid));
            }
        }
    }

    #[test]
    fn selection_errors_preserve_only_the_frozen_codes_and_fixed_copy() {
        for code in [
            "STALE_REVISION",
            "WORKSPACE_SUPERSEDED",
            "SETUP_REQUEST_CONFLICT",
        ] {
            let error = BridgeError::selection(Some(code));
            assert_eq!(error.code, code);
            assert_eq!(error.message, "Setup unavailable");
            assert!(!error.retryable);
        }
        for code in [None, Some("unknown"), Some("private-value")] {
            let error = BridgeError::selection(code);
            assert_eq!(error.code, "POLICY_DENIED");
            assert_eq!(error.message, "Setup unavailable");
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
