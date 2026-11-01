use super::*;
use std::sync::atomic::AtomicU64;
static SEQ: AtomicU64 = AtomicU64::new(0);

#[test]
fn root_exit_waits_for_a_healthy_associated_member_and_its_output() {
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
    let root = launch(&engine, &request("Write-Output root")).unwrap();
    let root_process = root.process.try_clone().unwrap();
    // A second, explicitly associated fixture process waits for the test's release file.
    let member = launch(
        &root.job,
        &request("while (!(Test-Path go)) { Start-Sleep -Milliseconds 20 }; Write-Output member"),
    )
    .unwrap();
    let member_process = member.process.try_clone().unwrap();
    let member_worker = std::thread::spawn(move || {
        member.monitor(
            Instant::now() + Duration::from_secs(10),
            &AtomicBool::new(false),
        )
    });
    let root_worker = std::thread::spawn(move || {
        root.monitor(
            Instant::now() + Duration::from_secs(10),
            &AtomicBool::new(false),
        )
    });
    // SAFETY: both wait handles remain live until their monitors join.
    assert_eq!(
        unsafe { WaitForSingleObject(root_process.as_raw_handle(), 5000) },
        WAIT_OBJECT_0
    );
    assert_eq!(
        unsafe { WaitForSingleObject(member_process.as_raw_handle(), 0) },
        WAIT_TIMEOUT
    );
    assert!(!root_worker.is_finished());
    fs::write(dir.join("go"), []).unwrap();
    let result = root_worker.join().unwrap().unwrap();
    assert_eq!(result.status, "exit");
    assert_eq!(String::from_utf8(result.stdout).unwrap().trim(), "root");
    assert_eq!(
        unsafe { WaitForSingleObject(member_process.as_raw_handle(), 0) },
        WAIT_OBJECT_0
    );
    assert_eq!(
        String::from_utf8(member_worker.join().unwrap().unwrap().stdout)
            .unwrap()
            .trim(),
        "member"
    );
    assert_eq!(active_count(&engine).unwrap(), 0);
    fs::remove_file(dir.join("go")).unwrap();
    fs::remove_dir(temp).unwrap();
    fs::remove_dir(dir).unwrap();
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
