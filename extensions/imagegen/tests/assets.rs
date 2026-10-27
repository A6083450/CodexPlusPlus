    #[test]
    fn native_fast_defers_generated_images_and_following_dom_extensions() {
        let settings = BackendSettings {
            enhancements_enabled: true,
            codex_app_native_fast_unlock: true,
            codex_app_stepwise_enabled: true,
            ..Default::default()
        };
        let script = injection_script_with_settings(57321, &settings)
            .replace(&whale_runtime_script(), "")
            .replace(include_str!("../../../assets/inject/composer-readiness.js"), "")
            .replace(native_fast_unlock_script(), "window.__codexPlusNativeFastUnlock={runtime:{update(){}}};")
            .replace(renderer_script(), "window.order.push('renderer');")
            .replace(stepwise_script(), "window.order.push('stepwise');");
        let harness = format!(r#"
            const vm=require('node:vm'),assert=require('node:assert/strict');
            for (const ready of [false,true]) {{
                let listener;
                const window={{order:[]}}, document={{body:ready?{{}}:null,documentElement:null,
                    querySelectorAll:()=>[],
                    addEventListener:(_name,callback)=>{{listener=callback;}}}};
                class MutationObserver {{ observe(node) {{ assert.ok(node);window.order.push('images'); }} }}
                vm.runInNewContext({},{{window,document,MutationObserver,setTimeout:()=>0,clearTimeout(){{}}}});
                if(!ready){{assert.deepEqual(window.order,[]);document.body={{}};listener();}}
                assert.deepEqual(window.order,['renderer','images','stepwise']);
            }}
        "#, serde_json::to_string(&script).unwrap());
        let temp = tempfile::tempdir().unwrap();
        let harness_path = temp.path().join("native-fast-dom.cjs");
        std::fs::write(&harness_path, harness).unwrap();
        let output = std::process::Command::new("node").arg(&harness_path).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }
