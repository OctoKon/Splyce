use super::*;
use std::sync::atomic::AtomicU64;
static SEQ: AtomicU64 = AtomicU64::new(0);

#[test]
fn root_exit_waits_for_a_healthy_associated_member_and_its_output() {
    associated_member_case(false);
}

#[test]
fn root_exit_waits_for_a_bcl_associated_member_and_its_output() {
    associated_member_case(true);
}

fn associated_member_case(bcl: bool) {
    let dir = std::env::temp_dir().join(format!(
        "splyce-associated-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&dir).unwrap();
    let temp = dir.join(".splyce-shell-fixture");
    fs::create_dir(&temp).unwrap();
    let request = |command: &str| Start {
        effect_id: "00000000-0000-0000-0000-000000000001".into(),
        action_id: "a".into(),
        workspace_id: "w".into(),
        session_id: "s".into(),
        ownership_epoch: 1,
        kind: "powershell".into(),
        command: command.into(),
        cwd: dir.clone(),
        temp: temp.clone(),
        timeout_ms: 10000,
        system_root: system_root().unwrap(),
    };
    let engine = create_job().unwrap();
    let started = Instant::now();
    let root = launch(
        &engine,
        &request(if bcl {
            "[IO.File]::WriteAllText('root-entered','entered'); [Console]::Out.WriteLine('root'); [IO.File]::WriteAllText('root-after','done')"
        } else {
            "[IO.File]::WriteAllText('root-module',[string]([IO.Path]::GetFullPath($env:PSModulePath) -eq [IO.Path]::GetFullPath($PSHOME+'\\Modules'))); [IO.File]::WriteAllText('root-entered','entered'); Write-Output root; [IO.File]::WriteAllText('root-after','done')"
        }),
    )
    .unwrap();
    let root_process = root.process.try_clone().unwrap();
    // A second, explicitly associated fixture process waits for the test's release file.
    let member = launch(
        &root.job,
        &request(if bcl {
            "[IO.File]::WriteAllText('member-entered',[string]($PWD.Path -eq [Environment]::CurrentDirectory)); while (![IO.File]::Exists('go')) { [Threading.Thread]::Sleep(20) }; [Console]::Out.WriteLine('member')"
        } else {
            "[IO.File]::WriteAllText('member-module',[string]([IO.Path]::GetFullPath($env:PSModulePath) -eq [IO.Path]::GetFullPath($PSHOME+'\\Modules'))); [IO.File]::WriteAllText('member-entered',[string]($PWD.Path -eq [Environment]::CurrentDirectory)); while (!(Test-Path go)) { Start-Sleep -Milliseconds 20 }; Write-Output member"
        }),
    )
    .unwrap();
    let member_process = member.process.try_clone().unwrap();
    let member_worker = std::thread::Builder::new()
        .name("shell-member-diagnostic".into())
        .spawn(move || {
            member.monitor(
                Instant::now() + Duration::from_secs(10),
                &AtomicBool::new(false),
            )
        })
        .unwrap();
    let root_worker = std::thread::Builder::new()
        .name("shell-root-diagnostic".into())
        .spawn(move || {
            eprintln!("root monitor starts after {:?}", started.elapsed());
            root.monitor(
                Instant::now() + Duration::from_secs(10),
                &AtomicBool::new(false),
            )
        })
        .unwrap();
    // SAFETY: both wait handles remain live until their monitors join.
    let root_wait = unsafe { WaitForSingleObject(root_process.as_raw_handle(), 5000) };
    let member_wait = unsafe { WaitForSingleObject(member_process.as_raw_handle(), 0) };
    let root_finished = root_worker.is_finished();
    let marker = dir.join("root-entered").exists();
    let root_after = dir.join("root-after").exists();
    let member_entry = fs::read_to_string(dir.join("member-entered")).ok();
    eprintln!("bcl={bcl} root_after={root_after} member_entry_cwd_equal={member_entry:?}");
    eprintln!(
        "after {:?}: root_wait={root_wait}, member_wait={member_wait}, root_finished={root_finished}, command_entered={marker}",
        started.elapsed()
    );
    let release = fs::write(dir.join("go"), []);
    let root_result = root_worker.join();
    let member_after_root = unsafe { WaitForSingleObject(member_process.as_raw_handle(), 0) };
    let member_result = member_worker.join();
    eprintln!("member_after_root={member_after_root}");
    for (name, result) in [("root", &root_result), ("member", &member_result)] {
        match result {
            Ok(Ok(output)) => eprintln!(
                "{name}: status={} code={} stdout={:?} stderr={:?}",
                output.status,
                output.code,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ),
            Ok(Err(error)) => eprintln!("{name}: monitor error {error:?}"),
            Err(_) => eprintln!("{name}: monitor panicked"),
        }
    }
    release.unwrap();
    if !bcl {
        let root_module = fs::read_to_string(dir.join("root-module"));
        let member_module = fs::read_to_string(dir.join("member-module"));
        eprintln!(
            "root_module_controlled={root_module:?} member_module_controlled={member_module:?}"
        );
        assert_eq!(root_module.unwrap(), "True");
        assert_eq!(member_module.unwrap(), "True");
    }
    assert_eq!(root_wait, WAIT_OBJECT_0);
    assert_eq!(member_wait, WAIT_TIMEOUT);
    assert!(!root_finished);
    let result = root_result.unwrap().unwrap();
    assert_eq!(result.status, "exit");
    assert_eq!(String::from_utf8(result.stdout).unwrap().trim(), "root");
    assert_eq!(member_after_root, WAIT_OBJECT_0);
    assert_eq!(
        String::from_utf8(member_result.unwrap().unwrap().stdout)
            .unwrap()
            .trim(),
        "member"
    );
    assert_eq!(active_count(&engine).unwrap(), 0);
    fs::remove_file(dir.join("go")).unwrap();
    fs::remove_file(dir.join("root-entered")).unwrap();
    fs::remove_file(dir.join("root-after")).unwrap();
    fs::remove_file(dir.join("member-entered")).unwrap();
    if !bcl {
        fs::remove_file(dir.join("root-module")).unwrap();
        fs::remove_file(dir.join("member-module")).unwrap();
    }
    fs::remove_dir(temp).unwrap();
    fs::remove_dir(dir).unwrap();
}

#[test]
fn terminal_slots_are_bounded_until_the_bound_result_is_acknowledged() {
    let dir = std::env::temp_dir();
    let temp = dir.join(".splyce-shell-fixture");
    let mut registry = Registry::new(create_job().unwrap());
    let call = |reg: &mut Registry, seq: u64, method: &str, params: Value| {
        let frame = serde_json::json!({"native":{"id":format!("fixture-{seq}"),"method":method,"params":params}});
        let bytes = reg.reply(frame).unwrap();
        read_frame(&mut bytes.as_slice()).unwrap().0["native"].clone()
    };
    let key = |seq: u64| serde_json::json!({"effectId":format!("00000000-0000-0000-0000-{seq:012}"),"actionId":format!("action-{seq}"),"sessionId":"session","workspaceId":"workspace","ownershipEpoch":1});
    let start = |reg: &mut Registry, seq: u64| {
        let mut params = key(seq);
        for (field,value) in serde_json::json!({"kind":"powershell","command":"Write-Output unused","cwd":dir,"temp":temp,"timeoutMs":1000,"systemRoot":dir.join("non-system")}).as_object().unwrap() {
            params[field] = value.clone();
        }
        call(reg, seq, "shell.start", params)["value"].clone()
    };
    for seq in 1..=8 {
        assert_eq!(start(&mut registry, seq)["state"], "pending");
    }
    let terminal = |reg: &mut Registry, seq: u64| {
        call(
            reg,
            12,
            "shell.poll",
            serde_json::json!({"key":key(seq),"offset":0}),
        )
    };
    let first = terminal(&mut registry, 1);
    assert_eq!(first["value"]["status"], "startFailed");
    assert_eq!(terminal(&mut registry, 1), first);
    assert_eq!(start(&mut registry, 9)["state"], "done");
    let mut stale = key(1);
    stale["ownershipEpoch"] = serde_json::json!(2);
    assert_eq!(
        call(&mut registry, 13, "shell.ack", stale)["error"]["code"],
        "SHELL_CLEANUP_UNCERTAIN"
    );
    assert_eq!(terminal(&mut registry, 1), first);
    assert_eq!(call(&mut registry, 14, "shell.ack", key(1))["ok"], true);
    assert_eq!(
        terminal(&mut registry, 1)["error"]["code"],
        "SHELL_CLEANUP_UNCERTAIN"
    );
    assert_eq!(
        call(&mut registry, 15, "shell.cancel", key(1))["error"]["code"],
        "SHELL_CLEANUP_UNCERTAIN"
    );
    assert_eq!(start(&mut registry, 16)["state"], "pending");
}

#[test]
fn disconnect_reaps_only_its_own_shell_registry() {
    let dir = std::env::temp_dir().join(format!(
        "splyce-shell-disconnect-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&dir).unwrap();
    let temp = dir.join(".splyce-shell-fixture");
    fs::create_dir(&temp).unwrap();
    let job = create_job().unwrap();
    let mut owner = Registry::new(job.try_clone().unwrap());
    let flag = owner.cleanup_failed.clone();
    let mut stranger = Registry::new(create_job().unwrap());
    let id = "00000000-0000-0000-0000-000000000002";
    let start = serde_json::json!({"native":{"id":"fixture-1","method":"shell.start","params":{
       "effectId":id,"actionId":"action","workspaceId":"w","sessionId":"s","ownershipEpoch":1,
       "kind":"powershell","command":"Start-Sleep -Seconds 30","timeoutMs":60000,"systemRoot":system_root().unwrap(),"cwd":dir,"temp":temp
    }}});
    let response = owner.reply(start.clone()).unwrap();
    assert_eq!(
        read_frame(&mut response.as_slice()).unwrap().0["native"]["ok"],
        true
    );
    assert_eq!(active_count(&job).unwrap(), 1);
    assert!(owner.reply(start).is_err());
    let key = serde_json::json!({"effectId":id,"actionId":"action","workspaceId":"w","sessionId":"s","ownershipEpoch":1});
    let denied = |registry: &mut Registry, key: &Value| {
        for method in ["shell.poll", "shell.cancel", "shell.ack"] {
            let params = if method == "shell.poll" {
                serde_json::json!({"key":key,"offset":0})
            } else {
                key.clone()
            };
            let response = registry.reply(serde_json::json!({"native":{"id":"fixture-2","method":method,"params":params}})).unwrap();
            assert_eq!(
                read_frame(&mut response.as_slice()).unwrap().0["native"]["error"]["code"],
                "SHELL_CLEANUP_UNCERTAIN"
            );
        }
    };
    denied(&mut stranger, &key);
    for (field, value) in [
        (
            "effectId",
            serde_json::json!("00000000-0000-0000-0000-000000000003"),
        ),
        ("actionId", serde_json::json!("other")),
        ("workspaceId", serde_json::json!("other")),
        ("sessionId", serde_json::json!("other")),
        ("ownershipEpoch", serde_json::json!(2)),
    ] {
        let mut wrong = key.clone();
        wrong[field] = value;
        denied(&mut owner, &wrong);
    }
    drop(stranger);
    assert_eq!(active_count(&job).unwrap(), 1);
    drop(owner);
    assert_eq!(active_count(&job).unwrap(), 0);
    assert!(!flag.load(Ordering::Acquire));
    fs::remove_dir(temp).unwrap();
    fs::remove_dir(dir).unwrap();
}

#[test]
fn powershell_uses_only_system_modules_at_the_existing_deadline() {
    let dir = std::env::temp_dir().join(format!(
        "splyce-modules-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&dir).unwrap();
    let temp = dir.join("temp");
    fs::create_dir(&temp).unwrap();
    let request = Start {
        effect_id: "00000000-0000-0000-0000-000000000001".into(),
        action_id: "a".into(),
        workspace_id: "w".into(),
        session_id: "s".into(),
        ownership_epoch: 1,
        kind: "powershell".into(),
        command: r#"$entries=@($env:PSModulePath.Split(';',[StringSplitOptions]::RemoveEmptyEntries)); [IO.File]::WriteAllText('modules-count',[string]$entries.Count); [IO.File]::WriteAllText('modules-path',[string]($entries.Count -eq 1 -and [IO.Path]::GetFullPath($entries[0]) -eq [IO.Path]::GetFullPath($PSHOME+'\Modules'))); $cmd=Get-Command Test-Path -ErrorAction Stop; if (![IO.Path]::GetFullPath($cmd.Module.Path).StartsWith([IO.Path]::GetFullPath($PSHOME+'\Modules\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'unexpected module' }; if (!(Test-Path -LiteralPath . -PathType Container)) { throw 'system cmdlet failed' }; Write-Output system-modules-ok"#.into(),
        cwd: dir.clone(),
        temp: temp.clone(),
        timeout_ms: 3000,
        system_root: system_root().unwrap(),
    };
    let engine = create_job().unwrap();
    let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
    let output = launch(&engine, &request)
        .unwrap()
        .monitor(deadline, &AtomicBool::new(false))
        .unwrap();
    let count = fs::read_to_string(dir.join("modules-count")).unwrap();
    let path = fs::read_to_string(dir.join("modules-path")).unwrap();
    fs::remove_dir_all(&dir).unwrap();
    assert_eq!(count, "1", "effective module entries must be system-only");
    assert_eq!(path, "True");
    assert_eq!(output.status, "exit", "{:?}", output.stderr);
    assert_eq!(output.code, 0);
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "system-modules-ok"
    );
    assert_eq!(active_count(&engine).unwrap(), 0);
}

#[test]
fn module_path_separator_spelling_preserves_utf16() {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let input = std::ffi::OsString::from_wide(&[0x43, 0x3a, 0x5c, 0xd83d, 0xde80, 0x5c, 0xd800]);
    assert_eq!(
        powershell_module_path(Path::new(&input))
            .encode_wide()
            .collect::<Vec<_>>(),
        [
            0x43, 0x3a, 0x2f, 0xd83d, 0xde80, 0x2f, 0xd800, 0x2f, 0x4d, 0x6f, 0x64, 0x75, 0x6c,
            0x65, 0x73
        ]
    );
}
