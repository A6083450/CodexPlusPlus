#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GeneratedImagesStatus {
    Found,
    Empty,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GeneratedImage {
    pub id: String,
    pub assistant_message_id: String,
    #[serde(default)]
    pub assistant_response_index: Option<usize>,
    pub media_type: String,
    pub base64_data: String,
    pub revised_prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GeneratedImagesResult {
    pub status: GeneratedImagesStatus,
    pub session_id: String,
    pub message: String,
    pub images: Vec<GeneratedImage>,
}
