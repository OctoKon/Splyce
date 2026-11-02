#![cfg(windows)]

#[path = "../src/credentials.rs"]
#[allow(dead_code)]
mod credentials;

#[path = "../src/workspace.rs"]
#[allow(dead_code)]
mod workspace;

#[path = "../src/ipc.rs"]
#[allow(dead_code)]
mod ipc;
#[path = "../src/process.rs"]
mod process;

use ipc::BridgeState;
use process::{EngineChild, EngineEvents};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

// These real Node endpoints qualify transport faults, never SDK or GUI readiness.
const HOST: &str = r#"
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, toNamespacedPath } from 'node:path';
writeFileSync('../started.txt', String(process.pid));
let pending = Buffer.alloc(0);
let bootstrapped = false;
let nativePending;
function send(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  process.stdout.write(Buffer.concat([header, payload]));
}
process.stdin.on('data', chunk => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const length = pending.readUInt32BE();
    if (pending.length < length + 4) break;
    const request = JSON.parse(pending.subarray(4, length + 4));
    pending = pending.subarray(length + 4);
    if (!bootstrapped) {
      writeFileSync('../bootstrap.json', JSON.stringify(request));
      const expectedPath = toNamespacedPath(resolve('../data'));
      const nativePath = toNamespacedPath(request.params?.appDataDir);
      if (Object.keys(request).length !== 3 || request.id !== 'native-bootstrap' || request.method !== 'native.bootstrap' || Object.keys(request.params).length !== 1 || nativePath !== expectedPath) process.exit(1);
      bootstrapped = true;
      if (existsSync('../reject-bootstrap')) {
        setTimeout(() => send({id:request.id,ok:true,value:{state:'initialized',extra:true}}), 300);
      } else send({id:request.id,ok:true,value:{state:'initialized'}});
      continue;
    }
    if (request.native) {
      if (!nativePending) process.exit(2);
      if (request.native.id === 'redact') {
        send({id:nativePending.id,ok:request.native.ok,value:request.native.value,error:request.native.error});
        nativePending = undefined;
        continue;
      }
      if (request.native.id === 'scope-open') {
        if (!request.native.ok) process.exit(3);
        send({native:{id:'secret-read',method:'credential.read',params:nativePending.params}});
      } else {
        const value = { privateOnly: true, available: request.native.ok,
          length: request.native.value?.secret?.length ?? 0, code: request.native.error?.code };
        send({id:nativePending.id,ok:true,value});
        nativePending = undefined;
      }
      continue;
    }
    if (request.method === 'control-malformed') {
      send({event:{frame:'control',kind:'stream.resync',sessionId:'session1',fromSeq:-1}});
      continue;
    }
    if (request.method === 'control-batch') {
      for (let index = 0; index < 3; index++) send({event:{frame:'control',kind:'stream.resync',sessionId:'session1',fromSeq:index}});
    }
    if (request.method === 'control-overflow') {
      for (let index = 0; index < 9; index++) send({event:{frame:'control',kind:'stream.resync',sessionId:'session1',fromSeq:index}});
      continue;
    }
    if (request.method === 'native-malformed') {
      send({native:{id:'bad',method:'credential.read',params:{target:'invalid',actionId:'a'}}});
      continue;
    }
    if (request.method === 'native-redact') {
      nativePending = request;
      send({native:{id:'redact',method:'credential.redact',params:request.params}});
      continue;
    }
    if (request.method === 'native-read' || request.method === 'native-flood-read') {
      if (request.method === 'native-flood-read') {
        for (let seq = 0; seq < 1100; seq++) send({event:{kind:'flood',seq}});
        send({event:{frame:'control',kind:'stream.resync',sessionId:'session1',fromSeq:7}});
      }
      nativePending = request;
      send({native:{id:'scope-open',method:'credential.scope.open',params:request.params}});
      continue;
    }
    if (request.method === 'hang') continue;
    if (request.method === 'stale') request.id = 'stale';
    if (request.method === 'oversize') {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(262144);
      process.stdout.write(header);
      continue;
    }
    if (request.method === 'push-before') send({ event: { kind: 'before', seq: 1 } });
    if (request.method === 'push-idle') {
      setTimeout(() => send({ event: { kind: 'idle', seq: 2 } }), 20);
    }
    if (request.method === 'bad-event') {
      send({ event: 'malformed' });
      continue;
    }
    if (request.method === 'bad-idle') {
      setTimeout(() => send({ event: 'malformed' }), 20);
    }
    if (request.method === 'subscribe') {
      const { sessionId, afterSeq } = request.params;
      send({ id: request.id, ok: true, value: { sessionId, scopeId: 'w1', afterSeq } });
      for (let seq = 1; seq <= 300; seq++) {
        send({ event: {
          schemaVersion: 1, protocolVersion: 2, recordId: `record${seq}`,
          eventId: `event${seq}`, createdAt: '2026-10-26T00:00:00.000Z',
          sourceIds: [], sessionId, scopeId: 'w1', seq,
          durable: false, kind: 'turn.stream_delta',
          payload: { runId: 'r1', delta: String(seq) }
        } });
      }
      process.stdout.write('', () => process.exit());
      continue;
    }
    let descendant;
    if (request.method === 'descendant') {
      descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore'
      }).pid;
    }
    send({
      id: request.id, ok: true, value: {
        pid: process.pid, descendant,
        ambient: !!process.env.SPLYCE_PROCESS_TEST_CANARY,
        nodeOptions: !!process.env.NODE_OPTIONS,
        keys: Object.keys(process.env)
      }
    });
    if (request.method === 'push-after') send({ event: { kind: 'after', seq: 3 } });
    if (request.method === 'subscribe-test') send({ event: { kind: 'subscribed', seq: 1100 } });
    if (request.method === 'flood') {
      setImmediate(() => {
        for (let seq = 0; seq < 1100; seq++) send({ event: { kind: 'flood', seq } });
      });
    }
    if (request.method === 'flood-bytes') {
      setImmediate(() => {
        for (let seq = 0; seq < 70; seq++) send({ event: { kind: 'large', seq, data: 'x'.repeat(150000) } });
      });
    }
  }
});
process.stdin.on('end', () => process.exit());
"#;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn digest(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn file_digest(path: &Path) -> String {
    let mut file = fs::File::open(path).unwrap();
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).unwrap();
        if count == 0 {
            return hex(&hash.finalize());
        }
        hash.update(&buffer[..count]);
    }
}

fn selected_node() -> &'static (PathBuf, String) {
    static NODE: OnceLock<(PathBuf, String)> = OnceLock::new();
    NODE.get_or_init(|| {
        let node = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/engine/node.exe");
        let output = std::process::Command::new(&node)
            .arg("--version")
            .output()
            .expect("The selected packaged Node executable is required");
        assert!(
            output.status.success(),
            "Packaged Node version query failed"
        );
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "v24.22.1");
        let hash = file_digest(&node);
        (node, hash)
    })
}

struct Fixture {
    directory: PathBuf,
    temporary_base: PathBuf,
    owner: String,
    manifest: Vec<u8>,
    expected_digest: String,
}

impl Fixture {
    fn new() -> Self {
        let (node, node_digest) = selected_node();
        let temporary_base = fs::canonicalize(std::env::temp_dir()).unwrap();
        let owner = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let directory = temporary_base.join(format!("splyce-process-transport-{owner}"));
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("owner.txt"), &owner).unwrap();
        let engine = directory.join("engine");
        fs::create_dir(&engine).unwrap();
        fs::copy(node, engine.join("node.exe")).unwrap();
        fs::write(engine.join("host.mjs"), HOST).unwrap();
        let manifest = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "piRevision": "d5b3de22d0e24a3e9c38a9410d3329b099717283",
            "files": [
                {"path": "node.exe", "sha256": node_digest},
                {"path": "host.mjs", "sha256": digest(HOST.as_bytes())}
            ]
        }))
        .unwrap();
        fs::write(engine.join("manifest.json"), &manifest).unwrap();
        let expected_digest = digest(&manifest);
        Self {
            directory,
            temporary_base,
            owner,
            manifest,
            expected_digest,
        }
    }

    fn engine(&self) -> PathBuf {
        self.directory.join("engine")
    }

    fn spawn(&self) -> EngineChild {
        EngineChild::spawn(
            &self.engine(),
            &self.expected_digest,
            &self.directory.join("data"),
        )
        .unwrap()
    }

    fn cleanup(&self) -> std::io::Result<()> {
        let metadata = fs::symlink_metadata(&self.directory)?;
        if metadata.file_attributes() & 0x400 != 0
            || fs::canonicalize(&self.directory)? != self.directory
            || self.directory.parent() != Some(self.temporary_base.as_path())
            || fs::read_to_string(self.directory.join("owner.txt"))? != self.owner
        {
            return Err(std::io::Error::other(
                "Fixture cleanup ownership did not match",
            ));
        }
        fs::remove_dir_all(&self.directory)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            if std::thread::panicking() {
                eprintln!("Fixture cleanup failed: {}", error.kind());
            } else {
                panic!("Fixture cleanup failed: {}", error.kind());
            }
        }
    }
}

fn observed_process(pid: &Value) -> OwnedHandle {
    let pid = u32::try_from(pid.as_u64().unwrap()).unwrap();
    // SAFETY: a successfully opened process handle is transferred to one OwnedHandle.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    assert!(!handle.is_null(), "Expected a live observed process");
    unsafe { OwnedHandle::from_raw_handle(handle) }
}

fn assert_running(process: &OwnedHandle) {
    // SAFETY: the process is owned; a zero timeout only observes its exit state.
    assert_eq!(
        unsafe { WaitForSingleObject(process.as_raw_handle(), 0) },
        WAIT_TIMEOUT
    );
}

#[test]
fn bootstrap_is_first_and_malformed_reply_reaps_child() {
    let fixture = Fixture::new();
    let child = fixture.spawn();
    let request: Value =
        serde_json::from_slice(&fs::read(fixture.directory.join("bootstrap.json")).unwrap())
            .unwrap();
    assert_eq!(
        request,
        json!({"id":"native-bootstrap","method":"native.bootstrap","params":{"appDataDir":fixture.directory.join("data").to_str().unwrap().strip_prefix(r"\\?\").unwrap_or(fixture.directory.join("data").to_str().unwrap())}})
    );
    assert!(!fixture.directory.join("data").exists());
    drop(child);
    fs::remove_file(fixture.directory.join("started.txt")).unwrap();
    fs::write(fixture.directory.join("reject-bootstrap"), b"").unwrap();
    let engine = fixture.engine();
    let digest = fixture.expected_digest.clone();
    let data = fixture.directory.join("data");
    let task = std::thread::spawn(move || {
        EngineChild::spawn(&engine, &digest, &data)
            .err()
            .unwrap()
            .code
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let started = fixture.directory.join("started.txt");
    let pid = loop {
        if let Ok(pid) = fs::read_to_string(&started)
            && let Ok(pid) = pid.parse::<u32>()
        {
            break pid;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    };
    let process = observed_process(&json!(pid));
    assert_eq!(task.join().unwrap(), "ENGINE_START");
    assert_exited(&process);
}

fn assert_exited(process: &OwnedHandle) {
    // SAFETY: the process is owned and the wait has a finite deadline.
    assert_eq!(
        unsafe { WaitForSingleObject(process.as_raw_handle(), 5000) },
        WAIT_OBJECT_0
    );
}

#[test]
fn real_node_transport_environment_and_descendant_cleanup() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let reply = child
        .request(&json!({"id": "one", "method": "descendant", "params": {}}))
        .unwrap();
    assert_eq!(reply["value"]["pid"], child.pid());
    assert_eq!(reply["value"]["ambient"], false);
    assert_eq!(reply["value"]["nodeOptions"], false);
    assert_eq!(reply["value"]["keys"], json!(["SystemRoot"]));
    let descendant = observed_process(&reply["value"]["descendant"]);
    assert_running(&descendant);
    child.stop().unwrap();
    assert_exited(&descendant);
    assert!(!child.is_running());
    child.stop().unwrap();
}

#[test]
fn oversized_child_frame_fails_and_reaps() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let started = Instant::now();
    let error = child
        .request(&json!({"id": "one", "method": "oversize", "params": {}}))
        .unwrap_err();
    assert_eq!(error.code, "ENGINE_FRAME");
    assert!(started.elapsed() < Duration::from_secs(6));
    assert!(!child.is_running());
}

#[test]
fn stale_reply_is_rejected_and_reaped() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let error = child
        .request(&json!({"id": "current", "method": "stale", "params": {}}))
        .unwrap_err();
    assert_eq!(error.code, "ENGINE_FRAME");
    assert!(!child.is_running());
}

#[test]
fn pushed_events_before_after_and_idle_preserve_reply_correlation() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let events: EngineEvents = child.events();
    for method in ["push-before", "push-after", "push-idle"] {
        let reply = child
            .request(&json!({"id": method, "method": method, "params": {}}))
            .unwrap();
        assert_eq!(reply["id"], method);
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut observed = Vec::new();
    while observed.len() < 3 && Instant::now() < deadline {
        observed.extend(events.drain().unwrap());
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        observed,
        vec![
            json!({"kind":"before","seq":1}),
            json!({"kind":"after","seq":3}),
            json!({"kind":"idle","seq":2}),
        ]
    );
    assert_eq!(
        child
            .request(&json!({"id":"ping","method":"ping","params":{}}))
            .unwrap()["id"],
        "ping"
    );
    child.stop().unwrap();
}

#[test]
fn event_queue_is_bounded_and_reports_required_reconciliation() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let events = child.events();
    child
        .request(&json!({"id":"flood","method":"flood","params":{}}))
        .unwrap();
    let saturation = Instant::now() + Duration::from_secs(3);
    while events.pending_for_test().0 < 1024 && Instant::now() < saturation {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(events.pending_for_test().0, 1024);
    let mut observed = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while observed.len() < 1024 && Instant::now() < deadline {
        let batch = events.drain().unwrap();
        assert!(batch.len() <= 256);
        observed.extend(batch);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(observed.len(), 1024);
    assert_eq!(events.drain().unwrap_err().code, "ENGINE_BACKPRESSURE");
    for (seq, event) in observed.iter().enumerate() {
        assert_eq!(event["seq"], seq);
    }
    child.stop().unwrap();
}

#[test]
fn stop_wakes_reader_when_event_queue_is_saturated() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let events = child.events();
    child
        .request(&json!({"id":"flood","method":"flood","params":{}}))
        .unwrap();
    let saturation = Instant::now() + Duration::from_secs(3);
    while events.pending_for_test().0 < 1024 && Instant::now() < saturation {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(events.pending_for_test().0, 1024);
    let started = Instant::now();
    child.stop().unwrap();
    assert!(started.elapsed() < Duration::from_secs(6));
    assert!(!child.is_running());
}

#[test]
fn event_byte_limits_bound_renderer_batches_and_keep_order() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let events = child.events();
    child
        .request(&json!({"id":"large","method":"flood-bytes","params":{}}))
        .unwrap();
    let saturation = Instant::now() + Duration::from_secs(3);
    while events.terminal_for_test().is_none() && Instant::now() < saturation {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(events.terminal_for_test(), Some("ENGINE_BACKPRESSURE"));
    let (_, pending_bytes) = events.pending_for_test();
    assert!((8_000_000..=8_388_608).contains(&pending_bytes));
    let mut count = 0;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let batch = match events.drain() {
            Ok(batch) => batch,
            Err(error) => {
                assert_eq!(error.code, "ENGINE_BACKPRESSURE");
                break;
            }
        };
        assert!(batch.len() <= 27); // 28 framed events exceed the 4 MiB renderer batch limit.
        for event in batch {
            assert_eq!(event["seq"], count);
            count += 1;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(count > 0 && count < 70);
    child.stop().unwrap();
}

#[test]
fn response_callback_precedes_post_reply_event_after_prior_queued_event() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let events = child.events();
    child
        .request(&json!({"id":"prior","method":"push-before","params":{}}))
        .unwrap();

    let installed = Arc::new(AtomicBool::new(false));
    let observer_installed = installed.clone();
    let observer = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            for event in events.drain().unwrap() {
                if event["kind"] == "subscribed" {
                    return observer_installed.load(Ordering::Acquire);
                }
            }
            assert!(Instant::now() < deadline, "post-reply event never arrived");
            std::thread::sleep(Duration::from_millis(1));
        }
    });
    let reply = child
        .request_with_response(
            &json!({"id":"subscribe","method":"subscribe-test","params":{}}),
            |response| {
                assert_eq!(response["id"], "subscribe");
                std::thread::sleep(Duration::from_millis(50));
                installed.store(true, Ordering::Release);
                true
            },
        )
        .unwrap();
    assert_eq!(reply["id"], "subscribe");
    assert!(observer.join().unwrap(), "event preceded response callback");
    child.stop().unwrap();
}

#[test]
fn rejected_response_callback_fails_closed_and_wakes_reader() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let error = child
        .request_with_response(
            &json!({"id":"subscribe","method":"subscribe-test","params":{}}),
            |_| false,
        )
        .unwrap_err();
    assert_eq!(error.code, "ENGINE_FRAME");
    assert!(!child.is_running());
}

#[test]
fn native_channel_delivers_all_buffered_events_before_child_exit_lifecycle() {
    let fixture = Fixture::new();
    let state = BridgeState::start(
        &fixture.engine(),
        &fixture.expected_digest,
        &fixture.directory.join("data"),
    )
    .unwrap();
    let timeline = Arc::new(Mutex::new(Vec::<Value>::new()));
    let event_sink = timeline.clone();
    let on_event = Channel::new(move |body| {
        let tauri::ipc::InvokeResponseBody::Json(body) = body else {
            panic!("Expected JSON native event channel delivery");
        };
        event_sink
            .lock()
            .unwrap()
            .push(serde_json::from_str(&body).unwrap());
        Ok(())
    });
    let lifecycle_sink = timeline.clone();
    let on_lifecycle = Channel::new(move |body| {
        let tauri::ipc::InvokeResponseBody::Json(body) = body else {
            panic!("Expected JSON native lifecycle channel delivery");
        };
        lifecycle_sink
            .lock()
            .unwrap()
            .push(serde_json::from_str(&body).unwrap());
        Ok(())
    });
    let ack = state
        .subscribe_channel("s1".into(), 0, on_event, on_lifecycle)
        .ok()
        .expect("Real packaged Node subscription ACK");
    assert_eq!(ack, json!({"sessionId":"s1","scopeId":"w1","afterSeq":0}));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if timeline
            .lock()
            .unwrap()
            .iter()
            .any(|entry| entry["kind"] == "engine_exited")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "engine exit lifecycle did not arrive"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let observed = timeline.lock().unwrap();
    assert_eq!(observed.len(), 301);
    for (index, event) in observed[..300].iter().enumerate() {
        assert_eq!(event["seq"], index + 1);
        assert_eq!(event["sessionId"], "s1");
        assert_eq!(event["scopeId"], "w1");
    }
    assert_eq!(observed[300]["kind"], "engine_exited");
    assert_eq!(observed[300]["expected"], false);
    assert_eq!(observed[300]["cleanupComplete"], true);
    drop(observed);
    assert!(state.stop().is_ok());
    assert!(state.stop().is_ok());
    assert_eq!(timeline.lock().unwrap().len(), 301);
}

#[test]
fn malformed_event_fails_closed_and_reaps_child() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let events = child.events();
    let error = child
        .request(&json!({"id":"bad","method":"bad-event","params":{}}))
        .unwrap_err();
    assert_eq!(error.code, "ENGINE_FRAME");
    assert_eq!(events.drain().unwrap_err().code, "ENGINE_FRAME");
    assert!(!child.is_running());
}

#[test]
fn malformed_idle_event_reports_failure_without_an_outstanding_request() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let events = child.events();
    child
        .request(&json!({"id":"idle","method":"bad-idle","params":{}}))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let code = loop {
        match events.drain() {
            Err(error) => break error.code,
            Ok(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            Ok(_) => panic!("malformed idle event was not reported"),
        }
    };
    assert_eq!(code, "ENGINE_FRAME");
    child.stop().unwrap();
    assert!(!child.is_running());
}

#[test]
fn unresponsive_child_times_out_and_reaps() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let started = Instant::now();
    let error = child
        .request(&json!({"id": "one", "method": "hang", "params": {}}))
        .unwrap_err();
    assert_eq!(error.code, "ENGINE_TIMEOUT");
    assert!(started.elapsed() >= Duration::from_secs(10));
    assert!(started.elapsed() < Duration::from_secs(16));
    assert!(!child.is_running());
}

struct FixtureParent(std::process::Child);

impl Drop for FixtureParent {
    fn drop(&mut self) {
        if self.0.try_wait().unwrap().is_none() {
            self.0.kill().unwrap();
            self.0.wait().unwrap();
        }
    }
}

#[test]
fn parent_termination_reaps_engine_and_descendant() {
    if let Some(root) = std::env::var_os("SPLYCE_PROCESS_CHILD_FIXTURE") {
        assert_eq!(
            std::env::var("SPLYCE_PROCESS_TEST_CANARY").unwrap(),
            "synthetic-canary"
        );
        let root = PathBuf::from(root);
        let expected = std::env::var("SPLYCE_PROCESS_CHILD_DIGEST").unwrap();
        let mut child =
            EngineChild::spawn(&root.join("engine"), &expected, &root.join("data")).unwrap();
        let reply = child
            .request(&json!({"id": "one", "method": "descendant", "params": {}}))
            .unwrap();
        let report = root.join("observed.pending");
        fs::write(&report, serde_json::to_vec(&reply).unwrap()).unwrap();
        fs::rename(report, root.join("observed.json")).unwrap();
        loop {
            std::thread::park();
        }
    }
    let fixture = Fixture::new();
    let mut parent = FixtureParent(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "parent_termination_reaps_engine_and_descendant",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("SPLYCE_PROCESS_CHILD_FIXTURE", &fixture.directory)
            .env("SPLYCE_PROCESS_CHILD_DIGEST", &fixture.expected_digest)
            .env("SPLYCE_PROCESS_TEST_CANARY", "synthetic-canary")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let report = fixture.directory.join("observed.json");
    let deadline = Instant::now() + Duration::from_secs(25);
    while !report.is_file() {
        assert!(
            parent.0.try_wait().unwrap().is_none(),
            "Fixture parent exited before reporting its children"
        );
        assert!(
            Instant::now() < deadline,
            "Fixture parent did not report before its deadline"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let reply: Value = serde_json::from_slice(&fs::read(report).unwrap()).unwrap();
    assert_eq!(reply["value"]["ambient"], false);
    assert_eq!(reply["value"]["keys"], json!(["SystemRoot"]));
    let engine = observed_process(&reply["value"]["pid"]);
    let descendant = observed_process(&reply["value"]["descendant"]);
    assert_running(&engine);
    assert_running(&descendant);
    parent.0.kill().unwrap();
    parent.0.wait().unwrap();
    assert_exited(&engine);
    assert_exited(&descendant);
}

#[test]
fn tampered_files_and_self_consistent_manifest_never_launch() {
    let fixture = Fixture::new();
    let changed_host = format!("{HOST}\n");
    fs::write(fixture.engine().join("host.mjs"), &changed_host).unwrap();
    assert!(
        EngineChild::spawn(
            &fixture.engine(),
            &fixture.expected_digest,
            &fixture.directory.join("data")
        )
        .is_err()
    );
    assert!(!fixture.directory.join("started.txt").exists());
    let mut changed_manifest: Value = serde_json::from_slice(&fixture.manifest).unwrap();
    changed_manifest["files"][1]["sha256"] = Value::String(digest(changed_host.as_bytes()));
    fs::write(
        fixture.engine().join("manifest.json"),
        serde_json::to_vec(&changed_manifest).unwrap(),
    )
    .unwrap();
    assert!(
        EngineChild::spawn(
            &fixture.engine(),
            &fixture.expected_digest,
            &fixture.directory.join("data")
        )
        .is_err()
    );
    assert!(!fixture.directory.join("started.txt").exists());
    fs::write(fixture.engine().join("host.mjs"), HOST).unwrap();
    fs::write(fixture.engine().join("manifest.json"), &fixture.manifest).unwrap();
    let mut child = fixture.spawn();
    let reply = child
        .request(&json!({"id": "restored", "method": "ping", "params": {}}))
        .unwrap();
    assert_eq!(reply["id"], "restored");
    assert!(fixture.directory.join("started.txt").is_file());
    child.stop().unwrap();
}

#[test]
fn private_credential_lane_stays_out_of_events_and_preserves_command_matching() {
    let reference = credentials::write_generated("transport-private-fixture").unwrap();
    struct Cleanup(credentials::CredentialRef);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            credentials::delete_owned(&self.0).unwrap();
        }
    }
    let cleanup = Cleanup(reference);
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let events = child.events();
    let params = json!({"scopeId":"private-scope","target":cleanup.0.as_str(),"actionId":"action1","profileRevision":"p1","connectionRevision":"c1"});
    let value = child
        .request(&json!({"id":"ordinary-command","method":"native-read","params":params}))
        .unwrap();
    assert_eq!(
        value,
        json!({"id":"ordinary-command","ok":true,"value":{"privateOnly":true,"available":true,"length":25}})
    );
    assert!(events.drain().unwrap().is_empty());
    let redacted = child.request(&json!({"id":"persistence-command","method":"native-redact","params":{"text":"transport-private-fixture"}})).unwrap();
    assert_eq!(
        redacted,
        json!({"id":"persistence-command","ok":true,"value":{"text":"[REDACTED:credential]","redactedCount":1}})
    );
    assert!(events.drain().unwrap().is_empty());
    assert_eq!(
        child
            .request(&json!({"id":"next","method":"echo","params":{}}))
            .unwrap()["id"],
        "next"
    );
    child.stop().unwrap();
}

#[test]
fn malformed_private_frame_terminates_transport_without_renderer_payload() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let events = child.events();
    let error = child
        .request(&json!({"id":"bad","method":"native-malformed","params":{}}))
        .unwrap_err();
    assert_eq!(error.code, "ENGINE_FRAME");
    assert!(!child.is_running());
    assert!(events.drain().is_err());
}

#[test]
fn saturated_events_fail_explicitly_while_private_service_stays_live() {
    let reference = credentials::write_generated("saturation-private-fixture").unwrap();
    struct Cleanup(credentials::CredentialRef);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            credentials::delete_owned(&self.0).unwrap();
        }
    }
    let cleanup = Cleanup(reference);
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let events = child.events();
    let params = json!({"scopeId":"saturated-scope","target":cleanup.0.as_str(),"actionId":"a1","profileRevision":"p1","connectionRevision":"c1"});
    let reply = child
        .request(&json!({"id":"private","method":"native-flood-read","params":params}))
        .unwrap();
    assert_eq!(reply["value"]["available"], true);
    assert_eq!(events.pending_for_test().0, 1024);
    assert_eq!(
        events.drain().unwrap(),
        vec![json!({"frame":"control","kind":"stream.resync","sessionId":"session1","fromSeq":7})]
    );
    let mut count = 0;
    loop {
        match events.drain() {
            Ok(batch) => {
                assert!(!batch.is_empty());
                for event in batch {
                    assert_eq!(event["seq"], count);
                    count += 1;
                }
            }
            Err(error) => {
                assert_eq!(error.code, "ENGINE_BACKPRESSURE");
                break;
            }
        }
    }
    assert_eq!(count, 1024);
    child.stop().unwrap();
    let mut recovered = fixture.spawn();
    assert_eq!(
        recovered
            .request(&json!({"id":"recovery","method":"push-before","params":{}}))
            .unwrap()["ok"],
        true
    );
    assert_eq!(recovered.events().drain().unwrap()[0]["kind"], "before");
    recovered.stop().unwrap();
}

#[test]
fn priority_control_lane_rejects_invalid_cursor_and_bounds_pending_frames() {
    for (method, code, expected_controls) in [
        ("control-malformed", "ENGINE_FRAME", 0),
        ("control-overflow", "ENGINE_BACKPRESSURE", 8),
    ] {
        let fixture = Fixture::new();
        let mut child = fixture.spawn();
        let events = child.events();
        assert_eq!(
            child
                .request(&json!({"id":"controls","method":method,"params":{}}))
                .unwrap_err()
                .code,
            code
        );
        if expected_controls > 0 {
            assert_eq!(events.drain().unwrap().len(), expected_controls);
        }
        assert!(events.drain().is_err());
        assert!(!child.is_running());
    }
}

#[test]
fn priority_controls_respect_single_frame_renderer_batches() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    let mut events = child.events();
    events.renderer_limits_for_test(1, process::MAX_FRAME_BYTES);
    child
        .request(&json!({"id":"batch","method":"control-batch","params":{}}))
        .unwrap();
    for cursor in 0..3 {
        assert_eq!(
            events.drain().unwrap(),
            vec![
                json!({"frame":"control","kind":"stream.resync","sessionId":"session1","fromSeq":cursor})
            ]
        );
    }
    assert!(events.drain().unwrap().is_empty());
    child.stop().unwrap();
}
