use proof_registry::RevocationReason;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _},
    xdr::{ContractEventBody, ScAddress, ScVal},
    Address, Bytes, BytesN, Env, Symbol, TryFromVal,
};
use std::collections::{BTreeMap, BTreeSet};
use test_support::{Contracts, AGE, AGGREGATE, KYC};

const EVENTS_DOC: &str = include_str!("../../../docs/EVENTS.md");

#[derive(Debug)]
struct CatalogEntry {
    topics: Vec<TopicSchema>,
    payload: String,
}

#[derive(Debug, Clone)]
enum TopicSchema {
    Literal(String),
    CredentialType,
}

#[derive(Debug, Clone)]
enum PayloadSchema {
    Scalar(String),
    Struct(Vec<(String, String)>),
}

#[derive(Debug, Default)]
struct EventSchemas {
    catalog: BTreeMap<(String, String), CatalogEntry>,
    payloads: BTreeMap<(String, String), (String, PayloadSchema)>,
}

impl EventSchemas {
    fn parse() -> Result<Self, String> {
        let mut schemas = Self::default();
        let mut section = None;
        let mut in_catalog = false;
        let mut lines = EVENTS_DOC.lines();

        while let Some(line) = lines.next() {
            let trimmed = line.trim();
            if trimmed == "## Complete Event Catalog" {
                in_catalog = true;
            } else if trimmed.starts_with("## ") {
                in_catalog = false;
            }
            if in_catalog && trimmed.starts_with("| `") {
                let cells: Vec<_> = trimmed
                    .split('|')
                    .map(str::trim)
                    .filter(|cell| !cell.is_empty())
                    .collect();
                if cells.len() < 5 {
                    return Err(format!("malformed catalog row: {trimmed}"));
                }
                let action = unquote(cells[1])?;
                let topics_tuple = unquote(cells[2])?;
                let topics_doc = topics_tuple
                    .strip_prefix('(')
                    .and_then(|value| value.strip_suffix(')'))
                    .ok_or_else(|| format!("malformed topics tuple: {}", cells[2]))?;
                let topics = topics_doc
                    .split(',')
                    .map(|topic| parse_topic(topic.trim()))
                    .collect::<Result<Vec<_>, _>>()?;
                let (
                    Some(TopicSchema::Literal(contract)),
                    Some(TopicSchema::Literal(topic_action)),
                ) = (topics.first(), topics.get(1))
                else {
                    return Err(format!(
                        "catalog topics must start with literal contract and action symbols: {}",
                        cells[2]
                    ));
                };
                if topic_action != &action {
                    return Err(format!(
                        "catalog action `{action}` does not match its topic `{topic_action}`"
                    ));
                }
                if topics.iter().enumerate().any(|(index, topic)| {
                    index != 2 && matches!(topic, TopicSchema::CredentialType)
                }) {
                    return Err(format!(
                        "credential type placeholder must be the third topic: {}",
                        cells[2]
                    ));
                }
                let payload = unquote(cells[3])?;
                let key = (contract.clone(), action.clone());
                if schemas
                    .catalog
                    .insert(
                        key.clone(),
                        CatalogEntry {
                            topics,
                            payload: payload.clone(),
                        },
                    )
                    .is_some()
                {
                    return Err(format!("duplicate catalog event: {key:?}"));
                }
            }

            if trimmed.starts_with("### ") {
                section = None;
                if let Some((_, rest)) = trimmed.split_once("`contract = \"") {
                    if let Some((contract, _)) = rest.split_once('"') {
                        section = Some((contract.to_string(), String::new()));
                    }
                }
            }

            if trimmed.starts_with("#### ") {
                section = trimmed
                    .strip_prefix("#### `")
                    .and_then(|rest| rest.split_once('`').map(|(name, _)| name))
                    .and_then(|name| name.split_once('.'))
                    .map(|(contract, action)| (contract.to_string(), action.to_string()));
            }

            if !trimmed.starts_with("pub struct ") {
                continue;
            }
            let Some((contract, action)) = section.take() else {
                return Err(format!("payload struct has no event section: {trimmed}"));
            };
            let name = trimmed
                .strip_prefix("pub struct ")
                .and_then(|value| value.split_whitespace().next())
                .ok_or_else(|| format!("malformed struct declaration: {trimmed}"))?
                .to_string();
            let mut fields = Vec::new();
            loop {
                let Some(field_line) = lines.next() else {
                    return Err(format!(
                        "unterminated payload struct {contract}.{action} {name}"
                    ));
                };
                let field_line = field_line.trim();
                if field_line == "}" {
                    break;
                }
                if field_line.is_empty() {
                    continue;
                }
                let Some((field, ty)) = field_line
                    .strip_prefix("pub ")
                    .and_then(|value| value.split_once(':'))
                else {
                    return Err(format!(
                        "malformed field in {contract}.{action} {name}: {field_line}"
                    ));
                };
                let ty = ty.trim().trim_end_matches(',').trim().to_string();
                fields.push((field.trim().to_string(), ty));
            }
            if fields.is_empty() {
                return Err(format!(
                    "payload struct {contract}.{action} {name} must be closed and non-empty"
                ));
            }
            let key = (contract.clone(), action.clone());
            if schemas
                .payloads
                .insert(key.clone(), (name, PayloadSchema::Struct(fields)))
                .is_some()
            {
                return Err(format!("duplicate payload section: {key:?}"));
            }
        }

        for (key, entry) in &schemas.catalog {
            let Some((name, schema)) = schemas.payloads.get(key) else {
                if entry.payload != "Address" && entry.payload != "()" {
                    return Err(format!(
                        "catalog event {key:?} has no payload struct section for {}",
                        entry.payload
                    ));
                }
                schemas.payloads.insert(
                    key.clone(),
                    (
                        entry.payload.clone(),
                        PayloadSchema::Scalar(entry.payload.clone()),
                    ),
                );
                continue;
            };
            if name != &entry.payload {
                return Err(format!(
                    "catalog event {key:?} names {}, but its section defines {name}",
                    entry.payload
                ));
            }
            if matches!(schema, PayloadSchema::Scalar(_)) {
                return Err(format!(
                    "catalog event {key:?} has a scalar payload section"
                ));
            }
        }

        for key in schemas.payloads.keys() {
            if !schemas.catalog.contains_key(key) {
                return Err(format!(
                    "payload section {key:?} is missing from the catalog"
                ));
            }
        }
        Ok(schemas)
    }
}

fn unquote(value: &str) -> Result<String, String> {
    value
        .strip_prefix('`')
        .and_then(|value| value.strip_suffix('`'))
        .map(str::to_string)
        .ok_or_else(|| format!("expected backtick-quoted value, got {value}"))
}

fn parse_topic(value: &str) -> Result<TopicSchema, String> {
    if value == "<credential_type>" {
        return Ok(TopicSchema::CredentialType);
    }
    if let Some(literal) = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    {
        if literal.is_empty() {
            return Err(format!("topic literal must not be empty: {value}"));
        }
        return Ok(TopicSchema::Literal(literal.to_string()));
    }
    unquote(value).map(TopicSchema::Literal)
}

fn value_type(value: &ScVal) -> String {
    match value {
        ScVal::Address(_) => "Address".to_string(),
        ScVal::Symbol(_) => "Symbol".to_string(),
        ScVal::U32(_) => "U32".to_string(),
        ScVal::U64(_) => "U64".to_string(),
        ScVal::I128(_) => "I128".to_string(),
        ScVal::Bool(_) => "Bool".to_string(),
        ScVal::Void => "()".to_string(),
        ScVal::Bytes(bytes) => format!("BytesN<{}>", bytes.len()),
        _ => format!("unexpected ScVal: {value:?}"),
    }
}

fn symbol_value(env: &Env, value: &ScVal) -> Option<String> {
    match value {
        ScVal::Symbol(_) => Symbol::try_from_val(env, value)
            .ok()
            .map(|symbol| symbol.to_string()),
        _ => None,
    }
}

fn expected_xdr_type(ty: &str) -> String {
    match ty {
        "RevocationReason" | "u32" => "U32".to_string(),
        "u64" => "U64".to_string(),
        "i128" => "I128".to_string(),
        "bool" => "Bool".to_string(),
        _ => ty.to_string(),
    }
}

fn payload_fields(env: &Env, value: &ScVal) -> Vec<(String, String)> {
    let ScVal::Map(map) = value else {
        return vec![("<payload>".to_string(), value_type(value))];
    };
    let Some(map) = map else {
        panic!("payload map is missing its entries");
    };
    let mut fields = Vec::with_capacity(map.len());
    for entry in map.iter() {
        let name = symbol_value(env, &entry.key)
            .unwrap_or_else(|| panic!("payload field name is not a Symbol: {:?}", entry.key));
        fields.push((name, value_type(&entry.val)));
    }
    fields.sort();
    fields
}

fn validate_payload(env: &Env, key: &(String, String), schema: &PayloadSchema, value: &ScVal) {
    match schema {
        PayloadSchema::Scalar(expected) => {
            let actual = value_type(value);
            assert_eq!(
                expected, &actual,
                "payload mismatch for {key:?}\n  expected: {expected}\n  actual:   {actual}"
            );
        }
        PayloadSchema::Struct(expected) => {
            let expected_summary = expected
                .iter()
                .map(|(name, ty)| format!("{name}: {ty}"))
                .collect::<Vec<_>>()
                .join(", ");
            let mut expected = expected
                .iter()
                .map(|(name, ty)| (name.clone(), expected_xdr_type(ty)))
                .collect::<Vec<_>>();
            expected.sort();
            let actual = payload_fields(env, value);
            assert_eq!(
                expected, actual,
                "payload mismatch for {key:?}\n  expected: {expected_summary}\n  actual:   {actual:?}"
            );
        }
    }
}

fn wasm_hash(env: &Env, artifact: &str) -> BytesN<32> {
    let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let configured_target = std::env::var_os("CARGO_TARGET_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("target"));
    let target_dir = if configured_target.is_absolute() {
        configured_target
    } else {
        workspace_root.join(configured_target)
    };
    let path = target_dir
        .join("wasm32v1-none/release")
        .join(format!("{artifact}.wasm"));
    if !path.exists() {
        let output = std::process::Command::new(env!("CARGO"))
            .args([
                "build",
                "--release",
                "--locked",
                "--target",
                "wasm32v1-none",
            ])
            .env("CARGO_TARGET_DIR", &target_dir)
            .current_dir(&workspace_root)
            .output()
            .expect("failed to build contract WASM for event conformance test");
        assert!(
            output.status.success(),
            "contract WASM build failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let wasm = std::fs::read(&path)
        .unwrap_or_else(|err| panic!("could not read {}: {err}", path.display()));
    env.deployer()
        .upload_contract_wasm(Bytes::from_slice(env, &wasm))
}

struct EventCapture {
    env: Env,
    schemas: EventSchemas,
    contracts_by_id: Vec<(Address, &'static str)>,
    observed: BTreeSet<(String, String)>,
}

impl EventCapture {
    fn new(env: Env, schemas: EventSchemas, contracts_by_id: Vec<(Address, &'static str)>) -> Self {
        Self {
            env,
            schemas,
            contracts_by_id,
            observed: BTreeSet::new(),
        }
    }

    fn capture(&mut self, expected_credentials: &[&str]) {
        let emitted = self.env.events().all();
        for (index, event) in emitted.events().iter().enumerate() {
            self.validate(event, index, expected_credentials);
        }
    }

    fn validate(
        &mut self,
        event: &soroban_sdk::xdr::ContractEvent,
        index: usize,
        expected_credentials: &[&str],
    ) {
        let Some(contract) = self
            .contracts_by_id
            .iter()
            .find(|(id, _)| match ScAddress::from(id.clone()) {
                ScAddress::Contract(contract_id) => {
                    event.contract_id.as_ref() == Some(&contract_id)
                }
                _ => false,
            })
            .map(|(_, name)| *name)
        else {
            return;
        };
        let ContractEventBody::V0(body) = &event.body;
        let actual_topics: Vec<_> = body
            .topics
            .iter()
            .map(|topic| symbol_value(&self.env, topic))
            .collect();
        assert_eq!(
            actual_topics.first().and_then(|topic| topic.as_deref()),
            Some(contract),
            "event {} contract topic mismatch: expected {contract:?}, actual {actual_topics:?}",
            index
        );
        let Some(action) = actual_topics.get(1).cloned().flatten() else {
            panic!(
                "event {} has no symbol action topic: {actual_topics:?}",
                index
            );
        };
        let key = (contract.to_string(), action);
        self.observed.insert(key.clone());
        let Some(entry) = self.schemas.catalog.get(&key) else {
            panic!(
                "undocumented emitted event {key:?}\n  actual topics: {actual_topics:?}\n  documented events: {:?}",
                self.schemas.catalog.keys().collect::<Vec<_>>()
            );
        };
        assert_eq!(
            entry.topics.len(),
            body.topics.len(),
            "topic count mismatch for {key:?}\n  expected: {:?}\n  actual:   {} ({actual_topics:?})",
            entry.topics,
            body.topics.len()
        );
        for (index, (expected, actual)) in entry.topics.iter().zip(&actual_topics).enumerate() {
            match expected {
                TopicSchema::Literal(expected) => assert_eq!(
                    actual.as_deref(),
                    Some(expected.as_str()),
                    "topic {index} mismatch for {key:?}\n  expected: {expected:?}\n  actual:   {actual:?}"
                ),
                TopicSchema::CredentialType => {
                    let actual = actual.as_deref().unwrap_or_else(|| {
                        panic!("credential topic for {key:?} must be a Symbol, got {actual:?}")
                    });
                    assert!(
                        expected_credentials.contains(&actual),
                        "credential topic mismatch for {key:?}\n  expected one of: {expected_credentials:?}\n  actual:   {actual:?}"
                    );
                }
            }
        }
        let (_, schema) = self.schemas.payloads.get(&key).unwrap_or_else(|| {
            panic!("missing parsed payload schema for documented event {key:?}")
        });
        validate_payload(&self.env, &key, schema, &body.data);
    }

    fn assert_complete(self) {
        let expected: BTreeSet<_> = self.schemas.catalog.keys().cloned().collect();
        let missing: Vec<_> = expected.difference(&self.observed).collect();
        assert!(
            missing.is_empty(),
            "documented events were not emitted by the representative calls:\n  missing: {missing:?}\n  observed: {:?}",
            self.observed
        );
    }
}

#[test]
fn emitted_events_match_documented_schema() {
    let schemas = EventSchemas::parse()
        .unwrap_or_else(|err| panic!("docs/EVENTS.md is not a valid event schema source:\n{err}"));
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let contracts = Contracts::deploy(&env);
    let pool = contracts.deploy_pool(&env, "kyc", None);
    let mut events = EventCapture::new(
        env.clone(),
        schemas,
        vec![
            (contracts.registry_id.clone(), "proof_reg"),
            (contracts.issuer_registry_id.clone(), "iss_reg"),
            (contracts.verifier_id.clone(), "cred_ver"),
            (pool.address.clone(), "gate_pool"),
        ],
    );
    events.capture(&[]);

    let issuer = contracts.register_issuer_for(&env, &KYC, &["kyc", "age"]);
    events.capture(&[]);
    contracts.set_vk(&env, &KYC, 1);
    events.capture(&["kyc"]);
    contracts.set_vk(&env, &AGE, 1);
    events.capture(&["age"]);
    contracts.set_vk(&env, &AGGREGATE, 1);
    events.capture(&["aggregate"]);

    let holder = Address::generate(&env);
    let verifier = Address::generate(&env);
    let kyc = symbol_short!("kyc");
    let age = symbol_short!("age");

    let batch_holder = Address::generate(&env);
    let mut submissions = soroban_sdk::Vec::new(&env);
    submissions.push_back(contracts.valid_submission(&env, &issuer, &KYC, 9_999));
    submissions.push_back(contracts.valid_submission(&env, &issuer, &AGE, 9_999));
    contracts
        .registry
        .submit_proofs(&batch_holder, &submissions);
    events.capture(&["kyc", "age"]);

    let aggregate_holder = Address::generate(&env);
    contracts
        .aggregate_call(&env, &issuer, &[9_999, 9_999])
        .submit(&contracts, &aggregate_holder);
    events.capture(&["kyc", "age"]);

    contracts.submit(&env, &holder, &issuer, &KYC, 9_999);
    events.capture(&["kyc"]);
    pool.deposit(&holder, &100);
    events.capture(&[]);
    pool.withdraw(&holder, &40);
    events.capture(&[]);

    let nullifier_holder = Address::generate(&env);
    contracts.registry.submit_proof_with_nullifier(
        &nullifier_holder,
        &issuer,
        &kyc,
        &KYC.proof_bytes(&env),
        &KYC.public_inputs_bytes(&env),
        &None,
        &9_999,
        &BytesN::from_array(&env, &[3u8; 32]),
        &BytesN::from_array(&env, &[4u8; 32]),
    );
    events.capture(&["kyc"]);

    contracts.registry.pause();
    events.capture(&[]);
    contracts.registry.unpause();
    events.capture(&[]);
    contracts.registry.record_nullifier(
        &BytesN::from_array(&env, &[1u8; 32]),
        &BytesN::from_array(&env, &[2u8; 32]),
    );
    events.capture(&[]);
    contracts
        .registry
        .grant_verification(&holder, &verifier, &kyc, &9_999);
    events.capture(&["kyc"]);
    contracts
        .registry
        .revoke_verification(&holder, &verifier, &kyc);
    events.capture(&["kyc"]);
    contracts
        .registry
        .revoke(&issuer, &holder, &kyc, &Some(RevocationReason::Fraud));
    events.capture(&["kyc"]);
    contracts.submit(&env, &holder, &issuer, &KYC, 9_999);
    events.capture(&["kyc"]);
    contracts.registry.revoke_proof(&holder, &kyc);
    events.capture(&["kyc"]);
    contracts.registry.revoke_all(&batch_holder);
    events.capture(&["kyc", "age"]);

    let old_key = KYC.issuer_pubkey(&env);
    let new_key = BytesN::from_array(&env, &[9u8; 64]);
    contracts
        .issuers
        .rotate_issuer_key(&issuer, &new_key, &(env.ledger().timestamp() + 86_400));
    events.capture(&[]);
    contracts.issuers.revoke_issuer_key(&issuer, &old_key);
    events.capture(&[]);
    contracts.issuers.revoke_issuer(&issuer);
    events.capture(&[]);

    contracts.verifier.deprecate_version(&age, &1);
    events.capture(&[]);
    env.ledger()
        .with_mut(|ledger| ledger.timestamp += 91 * 86_400);
    contracts.verifier.prune_version(&age, &1);
    events.capture(&["age"]);

    let proof_admin = Address::generate(&env);
    contracts.registry.propose_admin(&proof_admin);
    events.capture(&[]);
    contracts.registry.accept_admin();
    events.capture(&[]);
    let cancelled_proof_admin = Address::generate(&env);
    contracts.registry.propose_admin(&cancelled_proof_admin);
    events.capture(&[]);
    contracts.registry.cancel_admin_proposal();
    events.capture(&[]);

    let issuer_admin = Address::generate(&env);
    contracts.issuers.propose_admin(&issuer_admin);
    events.capture(&[]);
    contracts.issuers.accept_admin();
    events.capture(&[]);
    let cancelled_issuer_admin = Address::generate(&env);
    contracts.issuers.propose_admin(&cancelled_issuer_admin);
    events.capture(&[]);
    contracts.issuers.cancel_admin_proposal();
    events.capture(&[]);

    let verifier_admin = Address::generate(&env);
    contracts.verifier.propose_admin(&verifier_admin);
    events.capture(&[]);
    contracts.verifier.accept_admin();
    events.capture(&[]);
    let cancelled_verifier_admin = Address::generate(&env);
    contracts.verifier.propose_admin(&cancelled_verifier_admin);
    events.capture(&[]);
    contracts.verifier.cancel_admin_proposal();
    events.capture(&[]);

    contracts
        .registry
        .upgrade(&wasm_hash(&env, "proof_registry"));
    events.capture(&[]);
    contracts
        .verifier
        .upgrade(&wasm_hash(&env, "credential_verifier"));
    events.capture(&[]);

    events.assert_complete();
}
