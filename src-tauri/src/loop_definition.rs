use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LoopApiVersion {
    #[serde(rename = "workstreams.dev/v1alpha1")]
    V1Alpha1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LoopKind {
    #[serde(rename = "Loop")]
    Loop,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurationSpec {
    raw: String,
    seconds: u64,
}

impl DurationSpec {
    pub fn seconds(&self) -> u64 {
        self.seconds
    }
}

impl Serialize for DurationSpec {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.raw)
    }
}

impl<'de> Deserialize<'de> for DurationSpec {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        let seconds = parse_duration_seconds(&raw).map_err(serde::de::Error::custom)?;
        Ok(Self { raw, seconds })
    }
}

pub fn parse_duration_seconds(value: &str) -> Result<u64, String> {
    if value.len() < 2 || !value.is_ascii() {
        return Err("duration must match ^[1-9][0-9]*(s|m|h)$".to_string());
    }

    let (digits, unit) = value.split_at(value.len() - 1);
    if digits.starts_with('0') || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("duration must match ^[1-9][0-9]*(s|m|h)$".to_string());
    }

    let amount = digits
        .parse::<u64>()
        .map_err(|_| "duration is too large".to_string())?;
    let multiplier = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 60 * 60,
        _ => return Err("duration must match ^[1-9][0-9]*(s|m|h)$".to_string()),
    };

    amount
        .checked_mul(multiplier)
        .ok_or_else(|| "duration is too large".to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoopDefinition {
    #[serde(rename = "apiVersion")]
    pub api_version: LoopApiVersion,
    pub kind: LoopKind,
    pub metadata: LoopMetadata,
    pub spec: LoopSpec,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoopMetadata {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct LoopSpec {
    pub objective: String,
    pub trigger: ManualTrigger,
    pub orchestrator: OrchestratorSpec,
    pub worker: WorkerSpec,
    pub verification: Option<VerificationSpec>,
    pub evaluator: Option<EvaluatorSpec>,
    pub human_approval: Option<HumanApprovalSpec>,
    pub limits: LoopLimits,
    pub permissions: LoopPermissions,
    pub flow_control: LoopFlowControl,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManualTrigger {
    #[serde(rename = "type")]
    pub trigger_type: ManualTriggerType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ManualTriggerType {
    #[serde(rename = "manual")]
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorSpec {
    pub prompt: String,
    pub model: String,
    pub max_tasks_per_run: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerSpec {
    pub prompt: String,
    pub model: String,
    pub skills: Option<Vec<String>>,
    pub context: Option<WorkerContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct WorkerContext {
    pub files: Option<Vec<String>>,
    pub golden_patterns: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationSpec {
    pub command: VerificationCommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub timeout: DurationSpec,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatorSpec {
    pub model: String,
    pub prompt: String,
    pub on_reject: EvaluatorRejectPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatorRejectPolicy {
    pub action: EvaluatorRejectAction,
    pub max_revisions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HumanApprovalSpec {
    pub prompt: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvaluatorRejectAction {
    #[serde(rename = "revise")]
    Revise,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct LoopLimits {
    pub run_timeout: DurationSpec,
    pub task_attempts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct LoopPermissions {
    pub tools: LoopToolsPermission,
    pub public_effects: PublicEffectsPermission,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LoopToolsPermission {
    #[serde(rename = "full")]
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PublicEffectsPermission {
    #[serde(rename = "deny")]
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct LoopFlowControl {
    pub max_active_runs: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopDefinitionValidationError {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl LoopDefinitionValidationError {
    fn new(code: &str, field: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            field: field.to_string(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopSpecSummary {
    pub objective: String,
    pub trigger_type: String,
    pub orchestrator_model: String,
    pub worker_model: String,
    pub worker_skills: Vec<String>,
    pub context_files: Vec<String>,
    pub golden_patterns: Vec<String>,
    pub verification: Option<VerificationSummary>,
    pub evaluator: Option<EvaluatorSummary>,
    pub human_approval: Option<HumanApprovalSummary>,
    pub run_timeout_seconds: u64,
    pub task_attempts: u32,
    pub max_active_runs: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationSummary {
    pub program: String,
    pub resolved_program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub resolved_cwd: String,
    pub timeout_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatorSummary {
    pub model: String,
    pub max_revisions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanApprovalSummary {
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedLoopDefinition {
    pub document: LoopDefinition,
    pub path: PathBuf,
    pub hash: String,
    pub portable: bool,
    pub resolved_context_files: Vec<PathBuf>,
    pub resolved_golden_patterns: Vec<PathBuf>,
    pub resolved_verification: Option<ResolvedVerification>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedVerification {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub timeout_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopSpecInputFields {
    pub definition_id: String,
    pub name: String,
    pub objective: String,
    pub orchestrator_prompt: String,
    pub orchestrator_model: String,
    pub max_tasks_per_run: u32,
    pub worker_prompt: String,
    pub worker_model: String,
    pub worker_skills: Vec<String>,
    pub worker_context_files: Vec<String>,
    pub worker_golden_patterns: Vec<String>,
    pub verifier_program: Option<String>,
    pub verifier_args: Option<Vec<String>>,
    pub verifier_cwd: Option<String>,
    pub verifier_timeout_seconds: Option<u64>,
    pub evaluator_prompt: Option<String>,
    pub evaluator_model: Option<String>,
    pub evaluator_max_revisions: Option<u32>,
    pub human_approval_prompt: Option<String>,
    pub run_timeout_seconds: u64,
    pub task_attempts: u32,
}

impl ValidatedLoopDefinition {
    /// Definition-only fields for `crate::loops::LoopSpecInput`.
    ///
    /// The caller supplies runtime binding fields such as the workstream id.
    /// Evaluator and verifier fields remain optional so YAML definitions can
    /// use either sensor independently.
    pub fn to_loop_spec_input_fields(&self) -> LoopSpecInputFields {
        let evaluator = self.document.spec.evaluator.as_ref();
        let verification = self.resolved_verification.as_ref();

        LoopSpecInputFields {
            definition_id: self.document.metadata.id.clone(),
            name: self.document.metadata.name.clone(),
            objective: self.document.spec.objective.clone(),
            orchestrator_prompt: self.document.spec.orchestrator.prompt.clone(),
            orchestrator_model: self.document.spec.orchestrator.model.clone(),
            max_tasks_per_run: self.document.spec.orchestrator.max_tasks_per_run,
            worker_prompt: self.document.spec.worker.prompt.clone(),
            worker_model: self.document.spec.worker.model.clone(),
            worker_skills: self.document.spec.worker.skills.clone().unwrap_or_default(),
            worker_context_files: self
                .resolved_context_files
                .iter()
                .map(|path| path_to_string(path))
                .collect(),
            worker_golden_patterns: self
                .resolved_golden_patterns
                .iter()
                .map(|path| path_to_string(path))
                .collect(),
            verifier_program: verification.map(|value| value.program.clone()),
            verifier_args: verification.map(|value| value.args.clone()),
            verifier_cwd: verification.map(|value| path_to_string(&value.cwd)),
            verifier_timeout_seconds: verification.map(|value| value.timeout_seconds),
            evaluator_prompt: evaluator.map(|value| value.prompt.clone()),
            evaluator_model: evaluator.map(|value| value.model.clone()),
            evaluator_max_revisions: evaluator.map(|value| value.on_reject.max_revisions),
            human_approval_prompt: self
                .document
                .spec
                .human_approval
                .as_ref()
                .map(|value| value.prompt.clone()),
            run_timeout_seconds: self.document.spec.limits.run_timeout.seconds(),
            task_attempts: self.document.spec.limits.task_attempts,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopDefinitionResult {
    pub id: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub path: String,
    pub hash: String,
    pub portable: bool,
    pub spec: Option<LoopSpecSummary>,
    pub validation_errors: Vec<LoopDefinitionValidationError>,
    pub valid: bool,
    #[serde(skip)]
    pub definition: Option<ValidatedLoopDefinition>,
}

impl LoopDefinitionResult {
    fn unreadable(path: &Path, message: impl Into<String>) -> Self {
        Self {
            id: None,
            name: None,
            description: None,
            tags: Vec::new(),
            path: path_to_string(path),
            hash: String::new(),
            portable: true,
            spec: None,
            validation_errors: vec![LoopDefinitionValidationError::new(
                "read_error",
                "$",
                message,
            )],
            valid: false,
            definition: None,
        }
    }

    fn refresh_validity(&mut self) {
        self.valid = self.validation_errors.is_empty() && self.definition.is_some();
        if !self.valid {
            self.definition = None;
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopDefinitionCatalog {
    pub valid: Vec<LoopDefinitionResult>,
    pub invalid: Vec<LoopDefinitionResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopCatalogDefinition {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub path: String,
    pub hash: String,
    pub portable: bool,
    pub objective: String,
    pub has_verification: bool,
    pub has_evaluator: bool,
    pub has_human_approval: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct InvalidLoopCatalogDefinition {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopCatalog {
    pub definitions: Vec<LoopCatalogDefinition>,
    pub invalid: Vec<InvalidLoopCatalogDefinition>,
}

pub fn load_loop_definition(workstream_root: &Path, path: &Path) -> LoopDefinitionResult {
    match fs::read(path) {
        Ok(bytes) => parse_loop_definition_bytes(workstream_root, path, &bytes),
        Err(error) => LoopDefinitionResult::unreadable(
            path,
            format!("failed to read loop definition: {error}"),
        ),
    }
}

pub fn parse_loop_definition_bytes(
    workstream_root: &Path,
    path: &Path,
    bytes: &[u8],
) -> LoopDefinitionResult {
    let hash = hash_yaml_bytes(bytes);
    let document = match serde_yaml::from_slice::<LoopDefinition>(bytes) {
        Ok(document) => document,
        Err(error) => {
            let location = error
                .location()
                .map(|value| format!(" at line {}, column {}", value.line(), value.column()))
                .unwrap_or_default();
            return LoopDefinitionResult {
                id: None,
                name: None,
                description: None,
                tags: Vec::new(),
                path: path_to_string(path),
                hash,
                portable: true,
                spec: None,
                validation_errors: vec![LoopDefinitionValidationError::new(
                    "yaml_parse",
                    "$",
                    format!("{error}{location}"),
                )],
                valid: false,
                definition: None,
            };
        }
    };

    let id = Some(document.metadata.id.clone());
    let name = Some(document.metadata.name.clone());
    let description = document.metadata.description.clone();
    let tags = document.metadata.tags.clone().unwrap_or_default();
    let validation = validate_document(workstream_root, &document);
    let spec = Some(build_summary(&document, &validation));
    let definition = if validation.errors.is_empty() {
        Some(ValidatedLoopDefinition {
            document,
            path: path.to_path_buf(),
            hash: hash.clone(),
            portable: validation.portable,
            resolved_context_files: validation.resolved_context_files,
            resolved_golden_patterns: validation.resolved_golden_patterns,
            resolved_verification: validation.resolved_verification,
        })
    } else {
        None
    };
    let valid = validation.errors.is_empty();

    LoopDefinitionResult {
        id,
        name,
        description,
        tags,
        path: path_to_string(path),
        hash,
        portable: validation.portable,
        spec,
        validation_errors: validation.errors,
        valid,
        definition,
    }
}

pub fn discover_loop_definitions(workstream_root: &Path) -> Result<LoopDefinitionCatalog, String> {
    let loops_dir = workstream_root.join(".workstreams").join("loops");
    if !loops_dir.exists() {
        return Ok(LoopDefinitionCatalog {
            valid: Vec::new(),
            invalid: Vec::new(),
        });
    }

    if !loops_dir.is_dir() {
        return Err(format!(
            "loop definition path is not a directory: {}",
            path_to_string(&loops_dir)
        ));
    }

    let mut paths = Vec::new();
    for entry in fs::read_dir(&loops_dir)
        .map_err(|error| format!("failed to scan {}: {error}", path_to_string(&loops_dir)))?
    {
        let entry = entry.map_err(|error| {
            format!(
                "failed to read an entry in {}: {error}",
                path_to_string(&loops_dir)
            )
        })?;
        let path = entry.path();
        let is_loop_yaml = path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.ends_with(".loop.yaml"));
        if is_loop_yaml && path.is_file() {
            paths.push(path);
        }
    }
    paths.sort_by(|left, right| left.file_name().cmp(&right.file_name()));

    let mut results: Vec<_> = paths
        .iter()
        .map(|path| load_loop_definition(workstream_root, path))
        .collect();

    let mut ids: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, result) in results.iter().enumerate() {
        if let Some(id) = result.id.as_ref() {
            ids.entry(id.clone()).or_default().push(index);
        }
    }
    for (id, indexes) in ids {
        if indexes.len() < 2 {
            continue;
        }
        for index in indexes {
            results[index]
                .validation_errors
                .push(LoopDefinitionValidationError::new(
                    "duplicate_id",
                    "metadata.id",
                    format!("metadata.id '{id}' is used by more than one loop definition"),
                ));
            results[index].refresh_validity();
        }
    }

    let mut valid = Vec::new();
    let mut invalid = Vec::new();
    for result in results {
        if result.valid {
            valid.push(result);
        } else {
            invalid.push(result);
        }
    }

    Ok(LoopDefinitionCatalog { valid, invalid })
}

pub fn catalog_for_root(workstream_root: &Path) -> Result<LoopCatalog, String> {
    let catalog = discover_loop_definitions(workstream_root)?;
    let definitions = catalog
        .valid
        .into_iter()
        .filter_map(|result| {
            let definition = result.definition?;
            Some(LoopCatalogDefinition {
                id: definition.document.metadata.id,
                name: definition.document.metadata.name,
                description: definition.document.metadata.description,
                tags: definition.document.metadata.tags.unwrap_or_default(),
                path: path_to_string(&definition.path),
                hash: definition.hash,
                portable: definition.portable,
                objective: definition.document.spec.objective,
                has_verification: definition.document.spec.verification.is_some(),
                has_evaluator: definition.document.spec.evaluator.is_some(),
                has_human_approval: definition.document.spec.human_approval.is_some(),
            })
        })
        .collect();
    let invalid = catalog
        .invalid
        .into_iter()
        .map(|result| InvalidLoopCatalogDefinition {
            path: result.path,
            error: result
                .validation_errors
                .into_iter()
                .map(|error| format!("{}: {}", error.field, error.message))
                .collect::<Vec<_>>()
                .join("; "),
        })
        .collect();
    Ok(LoopCatalog {
        definitions,
        invalid,
    })
}

pub fn load_validated_definition(
    workstream_root: &Path,
    configured_path: &Path,
) -> Result<(ValidatedLoopDefinition, String), String> {
    let root = workstream_root
        .canonicalize()
        .map_err(|error| format!("failed to resolve workstream root: {error}"))?;
    let loops_dir = root.join(".workstreams").join("loops");
    let candidate = if configured_path.is_absolute() {
        configured_path.to_path_buf()
    } else {
        root.join(configured_path)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("failed to resolve loop definition: {error}"))?;
    if !canonical.starts_with(&loops_dir)
        || !canonical
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".loop.yaml"))
    {
        return Err("loop definition must be a .workstreams/loops/*.loop.yaml file".to_string());
    }
    let yaml = fs::read_to_string(&canonical)
        .map_err(|error| format!("failed to read loop definition: {error}"))?;
    let result = parse_loop_definition_bytes(&root, &canonical, yaml.as_bytes());
    result
        .definition
        .map(|definition| (definition, yaml))
        .ok_or_else(|| {
            result
                .validation_errors
                .into_iter()
                .map(|error| format!("{}: {}", error.field, error.message))
                .collect::<Vec<_>>()
                .join("; ")
        })
}

pub fn hash_yaml_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

#[derive(Default)]
struct ValidationState {
    errors: Vec<LoopDefinitionValidationError>,
    portable: bool,
    resolved_context_files: Vec<PathBuf>,
    resolved_golden_patterns: Vec<PathBuf>,
    resolved_verification: Option<ResolvedVerification>,
}

impl ValidationState {
    fn new() -> Self {
        Self {
            portable: true,
            ..Self::default()
        }
    }

    fn error(&mut self, code: &str, field: &str, message: impl Into<String>) {
        self.errors
            .push(LoopDefinitionValidationError::new(code, field, message));
    }
}

fn validate_document(workstream_root: &Path, document: &LoopDefinition) -> ValidationState {
    let mut state = ValidationState::new();
    let root = match workstream_root.canonicalize() {
        Ok(root) if root.is_dir() => root,
        Ok(_) => {
            state.error(
                "invalid_root",
                "$root",
                "workstream root is not a directory",
            );
            return state;
        }
        Err(error) => {
            state.error(
                "invalid_root",
                "$root",
                format!("failed to resolve workstream root: {error}"),
            );
            return state;
        }
    };

    if !is_valid_loop_id(&document.metadata.id) {
        state.error(
            "invalid_id",
            "metadata.id",
            "id must match ^[a-z][a-z0-9-]{2,63}$",
        );
    }
    validate_nonblank(&mut state, "metadata.name", &document.metadata.name);
    if let Some(description) = document.metadata.description.as_ref() {
        validate_nonblank(&mut state, "metadata.description", description);
    }
    if let Some(tags) = document.metadata.tags.as_ref() {
        validate_nonblank_list(&mut state, "metadata.tags", tags);
    }

    validate_nonblank(&mut state, "spec.objective", &document.spec.objective);
    validate_nonblank(
        &mut state,
        "spec.orchestrator.prompt",
        &document.spec.orchestrator.prompt,
    );
    validate_nonblank(
        &mut state,
        "spec.orchestrator.model",
        &document.spec.orchestrator.model,
    );
    if document.spec.orchestrator.max_tasks_per_run != 1 {
        state.error(
            "unsupported_value",
            "spec.orchestrator.maxTasksPerRun",
            "maxTasksPerRun must be exactly 1 in v1",
        );
    }

    validate_nonblank(
        &mut state,
        "spec.worker.prompt",
        &document.spec.worker.prompt,
    );
    validate_nonblank(&mut state, "spec.worker.model", &document.spec.worker.model);
    if let Some(skills) = document.spec.worker.skills.as_ref() {
        validate_nonblank_list(&mut state, "spec.worker.skills", skills);
    }

    if let Some(context) = document.spec.worker.context.as_ref() {
        if let Some(files) = context.files.as_ref() {
            resolve_contained_files(&root, files, "spec.worker.context.files", &mut state, false);
        }
        if let Some(patterns) = context.golden_patterns.as_ref() {
            resolve_contained_files(
                &root,
                patterns,
                "spec.worker.context.goldenPatterns",
                &mut state,
                true,
            );
        }
    }

    if document.spec.verification.is_none()
        && document.spec.evaluator.is_none()
        && document.spec.human_approval.is_none()
    {
        state.error(
            "missing_sensor",
            "spec",
            "at least one of spec.verification, spec.evaluator, or spec.humanApproval must be present",
        );
    }

    if let Some(verification) = document.spec.verification.as_ref() {
        validate_verification(&root, verification, &mut state);
    }

    if let Some(evaluator) = document.spec.evaluator.as_ref() {
        validate_nonblank(&mut state, "spec.evaluator.model", &evaluator.model);
        validate_nonblank(&mut state, "spec.evaluator.prompt", &evaluator.prompt);
        if evaluator.on_reject.max_revisions != 1 {
            state.error(
                "unsupported_value",
                "spec.evaluator.onReject.maxRevisions",
                "maxRevisions must be exactly 1 in v1",
            );
        }
    }
    if let Some(approval) = document.spec.human_approval.as_ref() {
        validate_nonblank(&mut state, "spec.humanApproval.prompt", &approval.prompt);
    }

    if document.spec.limits.task_attempts != 2 {
        state.error(
            "unsupported_value",
            "spec.limits.taskAttempts",
            "taskAttempts must be exactly 2 in v1",
        );
    }
    if document.spec.flow_control.max_active_runs != 1 {
        state.error(
            "unsupported_value",
            "spec.flowControl.maxActiveRuns",
            "maxActiveRuns must be exactly 1 in v1",
        );
    }

    state
}

fn validate_verification(
    root: &Path,
    verification: &VerificationSpec,
    state: &mut ValidationState,
) {
    let command = &verification.command;
    validate_nonblank(state, "spec.verification.command.program", &command.program);
    validate_nonblank(state, "spec.verification.command.cwd", &command.cwd);

    let resolved_program = if command.program.trim().is_empty() {
        None
    } else if is_path_like_program(&command.program) {
        let configured = Path::new(&command.program);
        if configured.is_absolute() {
            state.portable = false;
        }
        resolve_existing_path(
            root,
            configured,
            "spec.verification.command.program",
            PathRequirement::File,
            if configured.is_absolute() {
                Containment::None
            } else {
                Containment::Workstream
            },
            state,
        )
        .map(|path| path_to_string(&path))
    } else {
        Some(command.program.clone())
    };

    let configured_cwd = Path::new(&command.cwd);
    if configured_cwd.is_absolute() {
        state.portable = false;
    }
    let resolved_cwd = if command.cwd.trim().is_empty() {
        None
    } else {
        resolve_existing_path(
            root,
            configured_cwd,
            "spec.verification.command.cwd",
            PathRequirement::Directory,
            if configured_cwd.is_absolute() {
                Containment::None
            } else {
                Containment::Workstream
            },
            state,
        )
    };

    if let (Some(program), Some(cwd)) = (resolved_program, resolved_cwd) {
        state.resolved_verification = Some(ResolvedVerification {
            program,
            args: command.args.clone(),
            cwd,
            timeout_seconds: command.timeout.seconds(),
        });
    }
}

fn resolve_contained_files(
    root: &Path,
    configured_paths: &[String],
    field: &str,
    state: &mut ValidationState,
    golden_patterns: bool,
) {
    for (index, configured) in configured_paths.iter().enumerate() {
        let item_field = format!("{field}[{index}]");
        if configured.trim().is_empty() {
            state.error("blank_field", &item_field, "path must not be blank");
            continue;
        }
        let configured_path = Path::new(configured);
        if configured_path.is_absolute() {
            state.portable = false;
        }
        if let Some(path) = resolve_existing_path(
            root,
            configured_path,
            &item_field,
            PathRequirement::File,
            Containment::Workstream,
            state,
        ) {
            if golden_patterns {
                state.resolved_golden_patterns.push(path);
            } else {
                state.resolved_context_files.push(path);
            }
        }
    }
}

#[derive(Clone, Copy)]
enum PathRequirement {
    File,
    Directory,
}

impl fmt::Display for PathRequirement {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::File => formatter.write_str("file"),
            Self::Directory => formatter.write_str("directory"),
        }
    }
}

#[derive(Clone, Copy)]
enum Containment {
    None,
    Workstream,
}

fn resolve_existing_path(
    root: &Path,
    configured: &Path,
    field: &str,
    requirement: PathRequirement,
    containment: Containment,
    state: &mut ValidationState,
) -> Option<PathBuf> {
    let candidate = if configured.is_absolute() {
        normalize_absolute(configured)
    } else {
        match resolve_relative(root, configured) {
            Ok(path) => path,
            Err(message) => {
                state.error("path_escape", field, message);
                return None;
            }
        }
    };

    if matches!(containment, Containment::Workstream) && !candidate.starts_with(root) {
        state.error(
            "path_escape",
            field,
            "path must remain within the workstream root",
        );
        return None;
    }
    if !candidate.exists() {
        state.error(
            "missing_path",
            field,
            format!("referenced {requirement} does not exist"),
        );
        return None;
    }

    let resolved = match candidate.canonicalize() {
        Ok(path) => path,
        Err(error) => {
            state.error(
                "path_resolution",
                field,
                format!("failed to resolve referenced {requirement}: {error}"),
            );
            return None;
        }
    };
    if matches!(containment, Containment::Workstream) && !resolved.starts_with(root) {
        state.error(
            "path_escape",
            field,
            "resolved path must remain within the workstream root",
        );
        return None;
    }

    let matches_kind = match requirement {
        PathRequirement::File => resolved.is_file(),
        PathRequirement::Directory => resolved.is_dir(),
    };
    if !matches_kind {
        state.error(
            "wrong_path_type",
            field,
            format!("referenced path must be a {requirement}"),
        );
        return None;
    }

    Some(resolved)
}

fn resolve_relative(root: &Path, configured: &Path) -> Result<PathBuf, String> {
    let mut relative = PathBuf::new();
    for component in configured.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => relative.push(value),
            Component::ParentDir => {
                if !relative.pop() {
                    return Err("relative path must not escape the workstream root".to_string());
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("expected a relative path".to_string())
            }
        }
    }
    Ok(root.join(relative))
}

fn normalize_absolute(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn is_path_like_program(program: &str) -> bool {
    program.starts_with('.') || program.contains('/') || program.contains('\\')
}

fn is_valid_loop_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (3..=64).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn validate_nonblank(state: &mut ValidationState, field: &str, value: &str) {
    if value.trim().is_empty() {
        state.error("blank_field", field, "field must not be blank");
    }
}

fn validate_nonblank_list(state: &mut ValidationState, field: &str, values: &[String]) {
    for (index, value) in values.iter().enumerate() {
        if value.trim().is_empty() {
            state.error(
                "blank_field",
                &format!("{field}[{index}]"),
                "value must not be blank",
            );
        }
    }
}

fn build_summary(document: &LoopDefinition, validation: &ValidationState) -> LoopSpecSummary {
    let verification = document.spec.verification.as_ref().map(|value| {
        let resolved = validation.resolved_verification.as_ref();
        VerificationSummary {
            program: value.command.program.clone(),
            resolved_program: resolved
                .map(|item| item.program.clone())
                .unwrap_or_else(|| value.command.program.clone()),
            args: value.command.args.clone(),
            cwd: value.command.cwd.clone(),
            resolved_cwd: resolved
                .map(|item| path_to_string(&item.cwd))
                .unwrap_or_else(|| value.command.cwd.clone()),
            timeout_seconds: value.command.timeout.seconds(),
        }
    });
    let evaluator = document
        .spec
        .evaluator
        .as_ref()
        .map(|value| EvaluatorSummary {
            model: value.model.clone(),
            max_revisions: value.on_reject.max_revisions,
        });
    let human_approval = document
        .spec
        .human_approval
        .as_ref()
        .map(|value| HumanApprovalSummary {
            prompt: value.prompt.clone(),
        });
    let context = document.spec.worker.context.as_ref();

    LoopSpecSummary {
        objective: document.spec.objective.clone(),
        trigger_type: "manual".to_string(),
        orchestrator_model: document.spec.orchestrator.model.clone(),
        worker_model: document.spec.worker.model.clone(),
        worker_skills: document.spec.worker.skills.clone().unwrap_or_default(),
        context_files: context
            .and_then(|value| value.files.clone())
            .unwrap_or_default(),
        golden_patterns: context
            .and_then(|value| value.golden_patterns.clone())
            .unwrap_or_default(),
        verification,
        evaluator,
        human_approval,
        run_timeout_seconds: document.spec.limits.run_timeout.seconds(),
        task_attempts: document.spec.limits.task_attempts,
        max_active_runs: document.spec.flow_control.max_active_runs,
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEMP_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    struct TempRoot {
        path: PathBuf,
    }

    impl TempRoot {
        fn new() -> Self {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "workstreams-loop-definition-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn write(&self, relative: &str, contents: &[u8]) -> PathBuf {
            let path = self.path.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, contents).unwrap();
            path
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn yaml_with_sensors(verification: &str, evaluator: &str) -> String {
        format!(
            r#"apiVersion: workstreams.dev/v1alpha1
kind: Loop
metadata:
  id: test-loop
  name: Test loop
  description: A strict loop
  tags: [test]
spec:
  objective: Keep the repository healthy
  trigger:
    type: manual
  orchestrator:
    prompt: Select one task
    model: inherit
    maxTasksPerRun: 1
  worker:
    prompt: Implement the task
    model: concrete-model
    skills: [testing]
    context:
      files: [context.md]
      goldenPatterns: [golden.rs]
{verification}{evaluator}  limits:
    runTimeout: 30m
    taskAttempts: 2
  permissions:
    tools: full
    publicEffects: deny
  flowControl:
    maxActiveRuns: 1
"#
        )
    }

    fn verification_yaml(program: &str, cwd: &str) -> String {
        format!(
            "  verification:\n    command:\n      program: {program}\n      args: [--check]\n      cwd: {cwd}\n      timeout: 10m\n"
        )
    }

    fn evaluator_yaml() -> &'static str {
        "  evaluator:\n    model: inherit\n    prompt: Evaluate the result\n    onReject:\n      action: revise\n      maxRevisions: 1\n"
    }

    fn prepared_root() -> TempRoot {
        let root = TempRoot::new();
        root.write("context.md", b"context");
        root.write("golden.rs", b"fn golden() {}\n");
        root.write("scripts/verify.sh", b"#!/bin/sh\n");
        root
    }

    fn error_fields(result: &LoopDefinitionResult) -> Vec<&str> {
        result
            .validation_errors
            .iter()
            .map(|error| error.field.as_str())
            .collect()
    }

    #[test]
    fn duration_requires_a_positive_integer_and_supported_unit() {
        assert_eq!(parse_duration_seconds("1s").unwrap(), 1);
        assert_eq!(parse_duration_seconds("15m").unwrap(), 900);
        assert_eq!(parse_duration_seconds("2h").unwrap(), 7200);

        for invalid in ["", "s", "0s", "01s", "+1s", "1.5m", "1 d", "1d", " 1s"] {
            assert!(parse_duration_seconds(invalid).is_err(), "{invalid}");
        }
        assert!(parse_duration_seconds("18446744073709551615h").is_err());
    }

    #[test]
    fn parses_a_complete_definition_and_hashes_exact_raw_bytes() {
        let root = prepared_root();
        let yaml = yaml_with_sensors(
            &verification_yaml("./scripts/verify.sh", "."),
            evaluator_yaml(),
        );
        let path = root.path.join("test.loop.yaml");

        let result = parse_loop_definition_bytes(&root.path, &path, yaml.as_bytes());

        assert!(result.valid, "{:?}", result.validation_errors);
        assert_eq!(result.id.as_deref(), Some("test-loop"));
        assert_eq!(result.hash, hash_yaml_bytes(yaml.as_bytes()));
        assert!(result.portable);
        let summary = result.spec.as_ref().unwrap();
        assert_eq!(summary.run_timeout_seconds, 1800);
        assert_eq!(
            summary.verification.as_ref().unwrap().resolved_program,
            path_to_string(&root.path.join("scripts/verify.sh").canonicalize().unwrap())
        );

        let input = result
            .definition
            .as_ref()
            .unwrap()
            .to_loop_spec_input_fields();
        assert_eq!(input.evaluator_model.as_deref(), Some("inherit"));
        assert_eq!(input.verifier_timeout_seconds, Some(600));
    }

    #[test]
    fn rejects_unknown_fields_duplicate_keys_and_unimplemented_v1_syntax() {
        let root = prepared_root();
        let base = yaml_with_sensors("", evaluator_yaml());

        let unknown = base.replace(
            "    maxActiveRuns: 1",
            "    maxActiveRuns: 1\n    requirePreviousReview: false",
        );
        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("unknown.loop.yaml"),
            unknown.as_bytes(),
        );
        assert!(!result.valid);
        assert_eq!(result.validation_errors[0].code, "yaml_parse");

        let duplicate = base.replace("  name: Test loop", "  name: Test loop\n  name: Again");
        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("duplicate.loop.yaml"),
            duplicate.as_bytes(),
        );
        assert!(!result.valid);
        assert_eq!(result.validation_errors[0].code, "yaml_parse");

        let interval = base.replace("type: manual", "type: interval");
        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("interval.loop.yaml"),
            interval.as_bytes(),
        );
        assert!(!result.valid);

        let wrong_version = base.replace("workstreams.dev/v1alpha1", "workstreams.dev/v1");
        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("version.loop.yaml"),
            wrong_version.as_bytes(),
        );
        assert!(!result.valid);
    }

    #[test]
    fn requires_at_least_one_sensor_but_allows_either_one_independently() {
        let root = prepared_root();
        let no_sensor = yaml_with_sensors("", "");
        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("none.loop.yaml"),
            no_sensor.as_bytes(),
        );
        assert_eq!(error_fields(&result), vec!["spec"]);

        let evaluator_only = yaml_with_sensors("", evaluator_yaml());
        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("evaluator.loop.yaml"),
            evaluator_only.as_bytes(),
        );
        assert!(result.valid, "{:?}", result.validation_errors);
        let fields = result.definition.unwrap().to_loop_spec_input_fields();
        assert_eq!(fields.verifier_program, None);
        assert_eq!(fields.evaluator_model.as_deref(), Some("inherit"));

        let verification_only = yaml_with_sensors(&verification_yaml("cargo", "."), "");
        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("verification.loop.yaml"),
            verification_only.as_bytes(),
        );
        assert!(result.valid, "{:?}", result.validation_errors);
        let fields = result.definition.unwrap().to_loop_spec_input_fields();
        assert_eq!(fields.verifier_program.as_deref(), Some("cargo"));
        assert_eq!(fields.evaluator_model, None);

        let approval_only =
            yaml_with_sensors("", "  humanApproval:\n    prompt: Review the evidence\n");
        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("approval.loop.yaml"),
            approval_only.as_bytes(),
        );
        assert!(result.valid, "{:?}", result.validation_errors);
        let fields = result.definition.unwrap().to_loop_spec_input_fields();
        assert_eq!(
            fields.human_approval_prompt.as_deref(),
            Some("Review the evidence")
        );
    }

    #[test]
    fn validates_nonblank_fields_ids_and_fixed_v1_limits() {
        let root = prepared_root();
        let yaml = yaml_with_sensors("", evaluator_yaml())
            .replace("id: test-loop", "id: Bad")
            .replace("name: Test loop", "name: '   '")
            .replace("prompt: Select one task", "prompt: ''")
            .replace("model: concrete-model", "model: ' '")
            .replace("maxTasksPerRun: 1", "maxTasksPerRun: 2")
            .replace("maxRevisions: 1", "maxRevisions: 2")
            .replace("taskAttempts: 2", "taskAttempts: 3")
            .replace("maxActiveRuns: 1", "maxActiveRuns: 2");

        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("invalid.loop.yaml"),
            yaml.as_bytes(),
        );

        let fields = error_fields(&result);
        assert!(fields.contains(&"metadata.id"));
        assert!(fields.contains(&"metadata.name"));
        assert!(fields.contains(&"spec.orchestrator.prompt"));
        assert!(fields.contains(&"spec.worker.model"));
        assert!(fields.contains(&"spec.orchestrator.maxTasksPerRun"));
        assert!(fields.contains(&"spec.evaluator.onReject.maxRevisions"));
        assert!(fields.contains(&"spec.limits.taskAttempts"));
        assert!(fields.contains(&"spec.flowControl.maxActiveRuns"));
    }

    #[test]
    fn resolves_relative_paths_from_the_workstream_root_not_the_yaml_folder() {
        let root = prepared_root();
        let yaml = yaml_with_sensors(
            &verification_yaml("./scripts/verify.sh", "."),
            evaluator_yaml(),
        );
        let path = root.path.join(".workstreams/loops/nested/test.loop.yaml");

        let result = parse_loop_definition_bytes(&root.path, &path, yaml.as_bytes());

        assert!(result.valid, "{:?}", result.validation_errors);
        let definition = result.definition.unwrap();
        assert_eq!(
            definition.resolved_context_files,
            vec![root.path.join("context.md").canonicalize().unwrap()]
        );
        assert_eq!(
            definition.resolved_verification.unwrap().cwd,
            root.path.canonicalize().unwrap()
        );
    }

    #[test]
    fn leaves_command_names_for_path_lookup_and_marks_absolute_commands_nonportable() {
        let root = prepared_root();
        let command_yaml = yaml_with_sensors(&verification_yaml("cargo", "."), "");
        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("command.loop.yaml"),
            command_yaml.as_bytes(),
        );
        assert!(result.valid, "{:?}", result.validation_errors);
        assert!(result.portable);
        assert_eq!(
            result
                .definition
                .unwrap()
                .resolved_verification
                .unwrap()
                .program,
            "cargo"
        );

        let outside = TempRoot::new();
        let program = outside.write("verify.sh", b"#!/bin/sh\n");
        let cwd = outside.path.canonicalize().unwrap();
        let absolute_yaml = yaml_with_sensors(
            &verification_yaml(&path_to_string(&program), &path_to_string(&cwd)),
            "",
        );
        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("absolute.loop.yaml"),
            absolute_yaml.as_bytes(),
        );
        assert!(result.valid, "{:?}", result.validation_errors);
        assert!(!result.portable);
    }

    #[test]
    fn rejects_escaping_missing_and_wrong_type_repository_paths() {
        let root = prepared_root();
        fs::create_dir_all(root.path.join("directory")).unwrap();
        let yaml = yaml_with_sensors(&verification_yaml("cargo", "../outside"), "")
            .replace("files: [context.md]", "files: [../outside.md]")
            .replace(
                "goldenPatterns: [golden.rs]",
                "goldenPatterns: [missing.rs]",
            );
        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("escape.loop.yaml"),
            yaml.as_bytes(),
        );
        let fields = error_fields(&result);
        assert!(fields.contains(&"spec.verification.command.cwd"));
        assert!(fields.contains(&"spec.worker.context.files[0]"));
        assert!(fields.contains(&"spec.worker.context.goldenPatterns[0]"));

        let wrong_type = yaml_with_sensors(&verification_yaml("cargo", "."), "")
            .replace("files: [context.md]", "files: [directory]");
        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("wrong-type.loop.yaml"),
            wrong_type.as_bytes(),
        );
        assert!(result
            .validation_errors
            .iter()
            .any(|error| error.code == "wrong_path_type"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_context_that_resolves_outside_the_workstream() {
        use std::os::unix::fs::symlink;

        let root = prepared_root();
        let outside = TempRoot::new();
        let target = outside.write("outside.md", b"outside");
        symlink(&target, root.path.join("linked.md")).unwrap();
        let yaml = yaml_with_sensors("", evaluator_yaml())
            .replace("files: [context.md]", "files: [linked.md]");

        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("symlink.loop.yaml"),
            yaml.as_bytes(),
        );

        assert!(result
            .validation_errors
            .iter()
            .any(|error| error.code == "path_escape"));
    }

    #[test]
    fn discovery_is_shallow_sorted_and_invalidates_every_duplicate_id() {
        let root = prepared_root();
        let loops = root.path.join(".workstreams/loops");
        fs::create_dir_all(loops.join("nested")).unwrap();
        let evaluator = evaluator_yaml();
        let first = yaml_with_sensors("", evaluator);
        let second = first.replace("name: Test loop", "name: Second loop");
        let unique = first
            .replace("id: test-loop", "id: unique-loop")
            .replace("name: Test loop", "name: Unique loop");
        root.write(".workstreams/loops/b.loop.yaml", second.as_bytes());
        root.write(".workstreams/loops/a.loop.yaml", first.as_bytes());
        root.write(".workstreams/loops/c.loop.yaml", unique.as_bytes());
        root.write(".workstreams/loops/ignored.yaml", unique.as_bytes());
        root.write(
            ".workstreams/loops/nested/nested.loop.yaml",
            unique.as_bytes(),
        );

        let catalog = discover_loop_definitions(&root.path).unwrap();

        assert_eq!(catalog.valid.len(), 1);
        assert_eq!(catalog.valid[0].id.as_deref(), Some("unique-loop"));
        assert_eq!(catalog.invalid.len(), 2);
        assert!(catalog.invalid[0].path.ends_with("a.loop.yaml"));
        assert!(catalog.invalid[1].path.ends_with("b.loop.yaml"));
        assert!(catalog.invalid.iter().all(|result| result
            .validation_errors
            .iter()
            .any(|error| error.code == "duplicate_id")));
    }

    #[test]
    fn catalog_results_are_serializable_for_tauri() {
        let root = prepared_root();
        let yaml = yaml_with_sensors("", evaluator_yaml());
        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("serializable.loop.yaml"),
            yaml.as_bytes(),
        );

        let json = serde_json::to_value(result).unwrap();

        assert_eq!(json["id"], "test-loop");
        assert_eq!(json["valid"], true);
        assert!(json["spec"]["runTimeoutSeconds"].is_number());
        assert!(json["validationErrors"].is_array());
    }

    #[test]
    fn create_loop_skill_example_is_accepted_by_the_authoritative_parser() {
        let skill = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join(".github/skills/create-loop/SKILL.md"),
        )
        .expect("read create-loop skill");
        let yaml = skill
            .split("<!-- loop-example:start -->")
            .nth(1)
            .and_then(|tail| tail.split("<!-- loop-example:end -->").next())
            .and_then(|block| block.split("```yaml").nth(1))
            .and_then(|block| block.split("```").next())
            .map(str::trim)
            .expect("skill must contain one marked YAML example");
        let root = prepared_root();

        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("skill-example.loop.yaml"),
            yaml.as_bytes(),
        );

        assert!(result.valid, "{:?}", result.validation_errors);
    }

    #[test]
    fn human_approval_is_valid_as_the_only_sensor() {
        let root = prepared_root();
        let yaml = yaml_with_sensors(
            "",
            "  humanApproval:\n    prompt: Review the task evidence before accepting it.\n",
        );

        let result = parse_loop_definition_bytes(
            &root.path,
            &root.path.join("human.loop.yaml"),
            yaml.as_bytes(),
        );

        assert!(result.valid, "{:?}", result.validation_errors);
    }
}
