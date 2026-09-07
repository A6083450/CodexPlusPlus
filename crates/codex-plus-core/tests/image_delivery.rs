use base64::Engine;
use codex_plus_core::image_delivery::{ImageDeliveryStream, attach_images};
use serde_json::{Value, json};

#[test]
fn fragmented_stream_delivers_native_markdown_and_keeps_image_asset() {
    for size in [1, 7, 4096] {
        let temp = tempfile::tempdir().unwrap();
        let response = json!({"id":"resp-test","status":"completed","output":[
            {"id":"ig-test","type":"image_generation_call","status":"completed","result":base64::engine::general_purpose::STANDARD.encode(b"test image")}
        ]});
        let event = json!({"type":"response.completed","sequence_number":10,"response":response});
        let input = format!("event: response.completed\r\ndata: {}\r\n\r\n", event);
        let mut stream = ImageDeliveryStream::new(temp.path().to_path_buf());
        let mut bytes = Vec::new();
        for chunk in input.as_bytes().chunks(size) {
            bytes.extend(stream.push(chunk).unwrap());
        }
        bytes.extend(stream.finish());
        let text = String::from_utf8(bytes).unwrap();
        let events: Vec<Value> = text
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(7, events.len());
        assert_eq!("response.output_item.added", events[0]["type"]);
        assert_eq!("response.output_text.delta", events[2]["type"]);
        assert_eq!("response.output_item.done", events[5]["type"]);
        assert_eq!(16, events[6]["sequence_number"]);
        let item = &events[6]["response"]["output"][1];
        assert!(item["id"].as_str().unwrap().len() <= 64);
        assert_eq!(item, &events[5]["item"]);
        let markdown = item["content"][0]["text"].as_str().unwrap();
        let path = markdown
            .strip_prefix("![已生成图像](<")
            .unwrap()
            .strip_suffix(">)")
            .unwrap();
        assert_eq!(b"test image", std::fs::read(path).unwrap().as_slice());
        let mut completed = events[6]["response"].clone();
        assert!(
            attach_images(&mut completed, temp.path())
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn text_only_stream_is_byte_exact() {
    let temp = tempfile::tempdir().unwrap();
    let input = b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\ndata: [DONE]\n\n";
    let mut stream = ImageDeliveryStream::new(temp.path().to_path_buf());
    let mut output = Vec::new();
    for chunk in input.chunks(3) {
        output.extend(stream.push(chunk).unwrap());
    }
    output.extend(stream.finish());
    assert_eq!(input.as_slice(), output);
}
