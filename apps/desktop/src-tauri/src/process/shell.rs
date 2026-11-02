use super::*;
use std::collections::HashMap;
use std::fmt::Write as _;
use windows_sys::Win32::Foundation::ERROR_BROKEN_PIPE;
use windows_sys::Win32::System::Pipes::PeekNamedPipe;

const OUTPUT_LIMIT: usize = 8 << 20;
fn invalid() -> EngineError {
    EngineError::new("ENGINE_FRAME", "Invalid native shell control")
}
fn uncertain() -> EngineError {
    EngineError::new("ENGINE_CLEANUP", "Shell cleanup requires reconciliation")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    effect_id: String,
    action_id: String,
    workspace_id: String,
    session_id: String,
    ownership_epoch: u64,
    kind: String,
    command: String,
    cwd: PathBuf,
    temp: PathBuf,
    timeout_ms: u64,
    system_root: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Poll {
    key: Key,
    offset: usize,
}
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Key {
    effect_id: String,
    action_id: String,
    workspace_id: String,
    session_id: String,
    ownership_epoch: u64,
}
impl From<&Start> for Key {
    fn from(s: &Start) -> Self {
        Self {
            effect_id: s.effect_id.clone(),
            action_id: s.action_id.clone(),
            workspace_id: s.workspace_id.clone(),
            session_id: s.session_id.clone(),
            ownership_epoch: s.ownership_epoch,
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "method", deny_unknown_fields)]
enum Op {
    #[serde(rename = "shell.start")]
    Start { id: String, params: Box<Start> },
    #[serde(rename = "shell.poll")]
    Poll { id: String, params: Poll },
    #[serde(rename = "shell.cancel")]
    Cancel { id: String, params: Key },
    #[serde(rename = "shell.ack")]
    Ack { id: String, params: Key },
}
fn effect_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

struct Output {
    status: &'static str,
    code: u32,
    bytes: usize,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}
impl Output {
    fn empty(status: &'static str) -> Self {
        Self {
            status,
            code: 1,
            bytes: 0,
            stdout: vec![],
            stderr: vec![],
        }
    }
    fn page(&self, offset: usize) -> Result<Value, EngineError> {
        let len = self.stdout.len() + self.stderr.len();
        if offset > len {
            return Err(invalid());
        }
        let end = (offset + 32768).min(len);
        let mut data = String::with_capacity((end - offset) * 2);
        for byte in self.stdout[offset.min(self.stdout.len())..end.min(self.stdout.len())]
            .iter()
            .chain(
                self.stderr[offset.saturating_sub(self.stdout.len())
                    ..end.saturating_sub(self.stdout.len())]
                    .iter(),
            )
        {
            write!(&mut data, "{byte:02x}").expect("string write");
        }
        Ok(
            serde_json::json!({"state":"done","status":self.status,"code":self.code,"bytes":self.bytes,"stdoutBytes":self.stdout.len(),"offset":offset,"data":data,"last":end==len}),
        )
    }
}
enum Outcome {
    Worker(JoinHandle<Result<Output, EngineError>>),
    Ready(Result<Output, EngineError>),
}
struct Effect {
    key: Key,
    cancel: Arc<AtomicBool>,
    outcome: Outcome,
}
pub(crate) struct Registry {
    outer: OwnedHandle,
    effects: HashMap<String, Effect>,
    last_start: u64,
    pub(crate) cleanup_failed: Arc<AtomicBool>,
}
impl Registry {
    pub(crate) fn new(outer: OwnedHandle) -> Self {
        Self {
            outer,
            effects: HashMap::new(),
            last_start: 0,
            cleanup_failed: Arc::new(AtomicBool::new(false)),
        }
    }
    pub(crate) fn reply(&mut self, frame: Value) -> Result<Vec<u8>, EngineError> {
        if frame.as_object().is_none_or(|o| o.len() != 1) {
            return Err(invalid());
        }
        let op: Op = serde_json::from_value(frame["native"].clone()).map_err(|_| invalid())?;
        let (id, result) = match op {
            Op::Start { id, params } => {
                if !opaque_id(&id)
                    || !effect_id(&params.effect_id)
                    || ![&params.action_id, &params.workspace_id, &params.session_id]
                        .iter()
                        .all(|s| opaque_id(s))
                    || params.ownership_epoch == 0
                    || !matches!(params.kind.as_str(), "powershell" | "bash")
                    || params.command.contains('\0')
                    || !params.cwd.is_absolute()
                    || params.temp.parent() != Some(params.cwd.as_path())
                    || !params
                        .temp
                        .file_name()
                        .is_some_and(|n| n.to_string_lossy().starts_with(".splyce-shell-"))
                {
                    return Err(invalid());
                }
                let seq = id
                    .rsplit_once('-')
                    .and_then(|(_, n)| n.parse::<u64>().ok())
                    .ok_or_else(invalid)?;
                if seq <= self.last_start || self.effects.contains_key(&params.effect_id) {
                    return Err(invalid());
                }
                self.last_start = seq;
                if self.effects.len() >= 8 {
                    (id, Output::empty("startFailed").page(0))
                } else {
                    let cancel = Arc::new(AtomicBool::new(false));
                    let outcome = match launch(&self.outer, &params) {
                        Ok(child) => {
                            let canceled = cancel.clone();
                            let deadline = Instant::now()
                                .checked_add(Duration::from_millis(params.timeout_ms))
                                .ok_or_else(invalid)?;
                            match std::thread::Builder::new()
                                .name("splyce-owned-shell".into())
                                .spawn(move || child.monitor(deadline, &canceled))
                            {
                                Ok(worker) => Outcome::Worker(worker),
                                Err(_) => Outcome::Ready(Err(uncertain())),
                            }
                        }
                        Err(error) if error.code == "ENGINE_CLEANUP" => Outcome::Ready(Err(error)),
                        Err(error) => {
                            let mut result = Output::empty("startFailed");
                            result.code = error
                                .source
                                .as_ref()
                                .and_then(std::io::Error::raw_os_error)
                                .and_then(|n| u32::try_from(n).ok())
                                .unwrap_or(0);
                            Outcome::Ready(Ok(result))
                        }
                    };
                    let key = Key::from(params.as_ref());
                    self.effects.insert(
                        params.effect_id,
                        Effect {
                            key,
                            cancel,
                            outcome,
                        },
                    );
                    (id, Ok(serde_json::json!({"state":"pending"})))
                }
            }
            Op::Cancel { id, params } => {
                if !opaque_id(&id) || !effect_id(&params.effect_id) {
                    return Err(invalid());
                }
                (
                    id,
                    self.effects
                        .get(&params.effect_id)
                        .filter(|e| e.key == params)
                        .ok_or_else(uncertain)
                        .map(|e| {
                            e.cancel.store(true, Ordering::Release);
                            serde_json::json!({"state":"pending"})
                        }),
                )
            }
            Op::Ack { id, params } => {
                if !opaque_id(&id) || !effect_id(&params.effect_id) {
                    return Err(invalid());
                }
                let result =
                    if self.effects.get(&params.effect_id).is_some_and(|e| {
                        e.key == params && matches!(e.outcome, Outcome::Ready(Ok(_)))
                    }) {
                        self.effects.remove(&params.effect_id);
                        Ok(serde_json::json!({"state":"pending"}))
                    } else {
                        Err(uncertain())
                    };
                (id, result)
            }
            Op::Poll { id, params } => {
                if !opaque_id(&id) || !effect_id(&params.key.effect_id) {
                    return Err(invalid());
                }
                let result = self.poll(&params);
                (id, result)
            }
        };
        let response = match result {
            Ok(value) => serde_json::json!({"native":{"id":id,"ok":true,"value":value}}),
            Err(e) if e.code == "ENGINE_CLEANUP" => {
                serde_json::json!({"native":{"id":id,"ok":false,"error":{"code":"SHELL_CLEANUP_UNCERTAIN"}}})
            }
            Err(e) => return Err(e),
        };
        encode_frame(&response)
    }
    fn poll(&mut self, params: &Poll) -> Result<Value, EngineError> {
        let effect = self
            .effects
            .get_mut(&params.key.effect_id)
            .filter(|e| e.key == params.key)
            .ok_or_else(uncertain)?;
        if matches!(&effect.outcome,Outcome::Worker(w) if w.is_finished()) {
            let Outcome::Worker(w) =
                std::mem::replace(&mut effect.outcome, Outcome::Ready(Err(uncertain())))
            else {
                unreachable!()
            };
            effect.outcome = Outcome::Ready(w.join().unwrap_or_else(|_| Err(uncertain())));
        }
        match &effect.outcome {
            Outcome::Worker(_) => Ok(serde_json::json!({"state":"pending"})),
            Outcome::Ready(Err(_)) => Err(uncertain()),
            Outcome::Ready(Ok(output)) => output.page(params.offset),
        }
    }
}
impl Drop for Registry {
    fn drop(&mut self) {
        for effect in self.effects.values() {
            effect.cancel.store(true, Ordering::Release);
        }
        for (_, effect) in self.effects.drain() {
            let confirmed = match effect.outcome {
                Outcome::Worker(worker) => worker.join().is_ok_and(|r| r.is_ok()),
                Outcome::Ready(result) => result.is_ok(),
            };
            if !confirmed {
                self.cleanup_failed.store(true, Ordering::Release);
            }
        }
    }
}

// Windows CRT argv quoting, including backslashes adjacent to quotes or the closing delimiter.
fn quote(arg: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for ch in arg.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        out.extend(std::iter::repeat_n(
            '\\',
            if ch == '"' { 2 * slashes + 1 } else { slashes },
        ));
        slashes = 0;
        out.push(ch);
    }
    out.extend(std::iter::repeat_n('\\', 2 * slashes));
    out.push('"');
    out
}

struct Child {
    job: OwnedHandle,
    process: OwnedHandle,
    thread: OwnedHandle,
    stdout: File,
    stderr: File,
}
fn launch(outer: &OwnedHandle, p: &Start) -> Result<Child, EngineError> {
    let root = system_root()?;
    if root != p.system_root {
        return Err(io_error(std::io::Error::from_raw_os_error(3)));
    }
    let system = root.join("System32");
    let ps = system.join("WindowsPowerShell").join("v1.0");
    let (exe, args) = if p.kind == "bash" {
        let base = root.parent().ok_or_else(invalid)?;
        let exe = ["Program Files", "Program Files (x86)"]
            .iter()
            .map(|name| base.join(name).join("Git/bin/bash.exe"))
            .find(|path| path.is_file())
            .ok_or_else(|| io_error(std::io::Error::from_raw_os_error(2)))?;
        (exe, vec!["--noprofile", "--norc", "-c", p.command.as_str()])
    } else {
        (
            ps.join("powershell.exe"),
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                p.command.as_str(),
            ],
        )
    };
    let mut line = quote(&exe.to_string_lossy());
    for arg in args {
        line.push(' ');
        line.push_str(&quote(arg));
    }
    let mut command = wide(OsStr::new(&line))?;
    let executable = launch_path(&exe)?;
    let cwd = launch_path(&p.cwd)?;
    let path = std::env::join_paths([system.as_path(), root.as_path(), ps.as_path()])
        .map_err(|_| invalid())?;
    let mut env = Vec::new();
    for (key, value) in [
        ("ComSpec", system.join("cmd.exe").into_os_string()),
        ("PATH", path),
        ("PATHEXT", ".COM;.EXE;.BAT;.CMD".into()),
        ("SystemRoot", root.into_os_string()),
        ("TEMP", p.temp.clone().into_os_string()),
        ("TMP", p.temp.clone().into_os_string()),
    ] {
        env.extend(key.encode_utf16());
        env.push(b'=' as u16);
        env.extend(wide(&value)?);
    }
    env.push(0);
    let (stdin, closed) = pipe(false)?;
    drop(closed);
    let (stdout, out) = pipe(true)?;
    let (stderr, err) = pipe(true)?;
    let job = create_job()?;
    let handles = [
        stdin.as_raw_handle(),
        out.as_raw_handle(),
        err.as_raw_handle(),
    ];
    let jobs = [outer.as_raw_handle(), job.as_raw_handle()];
    let attributes = Attributes::new(&handles, &jobs)?;
    // SAFETY: startup, attribute lists, strings and the selected handles live across process creation.
    unsafe {
        let mut startup: STARTUPINFOEXW = zeroed();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        [
            startup.StartupInfo.hStdInput,
            startup.StartupInfo.hStdOutput,
            startup.StartupInfo.hStdError,
        ] = handles;
        startup.lpAttributeList = attributes.pointer;
        let mut pi: PROCESS_INFORMATION = zeroed();
        checked(CreateProcessW(
            executable.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            env.as_ptr().cast(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut pi,
        ))?;
        Ok(Child {
            job,
            process: own(pi.hProcess).map_err(|_| uncertain())?,
            thread: own(pi.hThread).map_err(|_| uncertain())?,
            stdout: stdout.into(),
            stderr: stderr.into(),
        })
    }
}

// Read only available bytes. The two pipe readers have one owner and never wait on each other.
fn drain(
    file: &mut File,
    target: &mut Vec<u8>,
    bytes: &mut usize,
) -> Result<(bool, bool), EngineError> {
    let mut available = 0;
    // SAFETY: valid owned pipe, no peek buffer and one available-count output.
    if unsafe {
        PeekNamedPipe(
            file.as_raw_handle(),
            null_mut(),
            0,
            null_mut(),
            &mut available,
            null_mut(),
        )
    } == 0
    {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
            return Ok((true, false));
        }
        return Err(io_error(err));
    }
    if available == 0 {
        return Ok((false, false));
    }
    let mut chunk = [0; 8192];
    let count = (available as usize).min(chunk.len());
    let count = file.read(&mut chunk[..count]).map_err(io_error)?;
    *bytes = bytes.checked_add(count).ok_or_else(uncertain)?;
    if *bytes <= OUTPUT_LIMIT {
        target.extend_from_slice(&chunk[..count]);
    }
    Ok((count == 0, count > 0))
}
impl Child {
    fn monitor(mut self, deadline: Instant, cancel: &AtomicBool) -> Result<Output, EngineError> {
        let mut r = Output::empty("exit");
        // SAFETY: associated suspended primary thread is owned by this effect.
        if !cancel.load(Ordering::Acquire) && {
            #[cfg(test)]
            let diagnostic = std::thread::current().name() == Some("shell-root-diagnostic");
            #[cfg(test)]
            if diagnostic {
                eprintln!("root ResumeThread start {:?}", Instant::now());
            }
            let resumed = unsafe { ResumeThread(self.thread.as_raw_handle()) };
            #[cfg(test)]
            if diagnostic {
                let error = (resumed == u32::MAX).then(std::io::Error::last_os_error);
                eprintln!(
                    "root ResumeThread end {:?}: result={resumed}, error={error:?}",
                    Instant::now()
                );
            }
            resumed == u32::MAX
        } {
            r.status = "startFailed";
        }
        let mut terminating = None;
        loop {
            let (out_eof, out_progress) = drain(&mut self.stdout, &mut r.stdout, &mut r.bytes)?;
            let (err_eof, err_progress) = drain(&mut self.stderr, &mut r.stderr, &mut r.bytes)?;
            if terminating.is_none() {
                if r.bytes > OUTPUT_LIMIT {
                    r.status = "overflow";
                } else if cancel.load(Ordering::Acquire) {
                    r.status = "aborted";
                } else if Instant::now() >= deadline {
                    r.status = "timeout";
                }
                if r.status != "exit" {
                    #[cfg(test)]
                    if r.status == "timeout"
                        && matches!(
                            std::thread::current().name(),
                            Some("shell-root-diagnostic" | "shell-member-diagnostic")
                        )
                    {
                        eprintln!("{:?} timeout: stdout_bytes={} stderr_bytes={} out_eof={out_eof} err_eof={err_eof}", std::thread::current().name(), r.stdout.len(), r.stderr.len());
                    }
                    // SAFETY: job denotes only this effect's associated process tree.
                    checked(unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) })?;
                    terminating = Some(Instant::now() + Duration::from_secs(5));
                }
            }
            if active_count(&self.job)? == 0 && out_eof && err_eof {
                // SAFETY: process is a signaled owned member of the now-empty job.
                checked(unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut r.code) })?;
                if r.bytes > OUTPUT_LIMIT {
                    r.status = "overflow";
                }
                if r.status != "exit" {
                    r.stdout.clear();
                    r.stderr.clear();
                }
                return Ok(r);
            }
            if terminating.is_some_and(|t| Instant::now() >= t) {
                return Err(uncertain());
            }
            if !(out_progress || err_progress) {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
}

#[cfg(test)]
mod shell_tests {
    include!("shell_tests.rs");
}
