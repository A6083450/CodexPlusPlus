#[tokio::test]
async fn image_models_use_hosted_generation_when_functions_arrive_as_additional_tools() {
    let target = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let target_addr = target.local_addr().unwrap();
    let target_server = tokio::spawn(capture_json_request_once(target));
    let request = json!({"model":"gpt-image-2.5-flare", "input":[
        {"type":"additional_tools","tools":[
            {"type":"namespace","name":"image_gen","tools":[{"type":"function","name":"imagegen"}]},
            {"type":"function","name":"inspect_image"}
        ]}
    ]});
    let settings = model_route_settings("gpt-image-2.5-flare", "", format!("http://{target_addr}/v1"));
    let result = open_responses_proxy_request_with_settings(&request.to_string(), settings).await.unwrap();
    assert_eq!(result.status_code, 200);
    let (_, actual) = target_server.await.unwrap();
    assert_eq!(actual["tools"], json!([{"type":"image_generation"}]));
    assert_eq!(actual["input"][0]["tools"], json!([{"type":"function","name":"inspect_image"}]));
}

#[tokio::test]
async fn responses_proxy_resolves_image_tool_collision_only_with_hosted_tool() {
    for (hosted, model) in [(false, "gpt-6"), (true, "gpt-6"), (false, "gpt-image-2")] {
        let target = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let target_addr = target.local_addr().unwrap();
        let target_server = tokio::spawn(capture_json_request_once(target));
        let unrelated = json!({"type": "function", "name": "inspect_image"});
        let mut tools = vec![
            json!({"type": "function", "name": "image_gen.imagegen"}),
            json!({"type": "namespace", "name": "image_gen", "tools": [
                {"type": "function", "name": "imagegen"}, unrelated.clone()
            ]}),
            unrelated.clone(),
        ];
        if hosted {
            tools.push(json!({"type": "image_generation"}));
        }
        let request = json!({"model": model, "input": "draw", "tools": tools,
            "tool_choice": {"type": "function", "name": "image_gen.imagegen"}});
        let settings = model_route_settings(model, "", format!("http://{target_addr}/v1"));
        let result = open_responses_proxy_request_with_settings(&request.to_string(), settings)
            .await
            .unwrap();
        assert_eq!(200, result.status_code);
        let (_, actual) = target_server.await.unwrap();
        if hosted || model == "gpt-image-2" {
            assert_eq!(
                json!([
                    {"type": "namespace", "name": "image_gen", "tools": [unrelated.clone()]},
                    unrelated, {"type": "image_generation"}
                ]),
                actual["tools"]
            );
            assert_eq!(json!({"type": "image_generation"}), actual["tool_choice"]);
        } else {
            assert_eq!(request, actual);
        }
    }
}
