use super::{ModelPrice, TokenUsage};

const DEFAULT_MODEL_PRICES: [(&str, ModelPrice); 10] = [
    (
        "gpt-5.6-sol",
        ModelPrice {
            input_nanos_per_million: 5_000_000_000,
            cached_input_nanos_per_million: Some(500_000_000),
            cache_write_nanos_per_million: Some(6_250_000_000),
            output_nanos_per_million: 30_000_000_000,
        },
    ),
    (
        "gpt-5.6-terra",
        ModelPrice {
            input_nanos_per_million: 2_500_000_000,
            cached_input_nanos_per_million: Some(250_000_000),
            cache_write_nanos_per_million: Some(3_125_000_000),
            output_nanos_per_million: 15_000_000_000,
        },
    ),
    (
        "gpt-5.6-luna",
        ModelPrice {
            input_nanos_per_million: 1_000_000_000,
            cached_input_nanos_per_million: Some(100_000_000),
            cache_write_nanos_per_million: Some(1_250_000_000),
            output_nanos_per_million: 6_000_000_000,
        },
    ),
    (
        "gpt-5.3-codex",
        ModelPrice {
            input_nanos_per_million: 1_750_000_000,
            cached_input_nanos_per_million: Some(175_000_000),
            cache_write_nanos_per_million: None,
            output_nanos_per_million: 14_000_000_000,
        },
    ),
    (
        "gpt-5.4",
        ModelPrice {
            input_nanos_per_million: 2_500_000_000,
            cached_input_nanos_per_million: Some(250_000_000),
            cache_write_nanos_per_million: None,
            output_nanos_per_million: 15_000_000_000,
        },
    ),
    (
        "gpt-5.4-mini",
        ModelPrice {
            input_nanos_per_million: 750_000_000,
            cached_input_nanos_per_million: Some(75_000_000),
            cache_write_nanos_per_million: None,
            output_nanos_per_million: 4_500_000_000,
        },
    ),
    (
        "gpt-5.4-nano",
        ModelPrice {
            input_nanos_per_million: 200_000_000,
            cached_input_nanos_per_million: Some(20_000_000),
            cache_write_nanos_per_million: None,
            output_nanos_per_million: 1_250_000_000,
        },
    ),
    (
        "gpt-5.4-pro",
        ModelPrice {
            input_nanos_per_million: 30_000_000_000,
            cached_input_nanos_per_million: None,
            cache_write_nanos_per_million: None,
            output_nanos_per_million: 180_000_000_000,
        },
    ),
    (
        "gpt-5.5",
        ModelPrice {
            input_nanos_per_million: 5_000_000_000,
            cached_input_nanos_per_million: Some(500_000_000),
            cache_write_nanos_per_million: None,
            output_nanos_per_million: 30_000_000_000,
        },
    ),
    (
        "gpt-5.5-pro",
        ModelPrice {
            input_nanos_per_million: 30_000_000_000,
            cached_input_nanos_per_million: None,
            cache_write_nanos_per_million: None,
            output_nanos_per_million: 180_000_000_000,
        },
    ),
];

pub fn default_model_price(model: &str) -> Option<ModelPrice> {
    DEFAULT_MODEL_PRICES
        .iter()
        .find_map(|(name, price)| name.eq_ignore_ascii_case(model).then_some(*price))
}

pub fn fast_multiplier_millis(model: &str) -> u32 {
    if model_matches_family(model, "gpt-5.6") {
        2_000
    } else if model_matches_family(model, "gpt-5.5") {
        2_500
    } else if model_matches_family(model, "gpt-5.4") {
        2_000
    } else {
        1_000
    }
}

pub fn usage_cost_nanos(usage: TokenUsage, price: ModelPrice, fast_multiplier_millis: u32) -> u64 {
    let uncached_input = usage.input.saturating_sub(usage.cached_input);
    let cached_input_price = price
        .cached_input_nanos_per_million
        .unwrap_or(price.input_nanos_per_million);
    let cache_write_price = price
        .cache_write_nanos_per_million
        .unwrap_or(price.input_nanos_per_million);
    let total = component_cost(uncached_input, price.input_nanos_per_million)
        .saturating_add(component_cost(usage.cached_input, cached_input_price))
        .saturating_add(component_cost(usage.cache_write, cache_write_price))
        .saturating_add(component_cost(usage.output, price.output_nanos_per_million));
    let adjusted = total.saturating_mul(u128::from(fast_multiplier_millis)) / 1_000;
    adjusted.min(u128::from(u64::MAX)) as u64
}

fn component_cost(tokens: u64, nanos_per_million: u64) -> u128 {
    u128::from(tokens) * u128::from(nanos_per_million) / 1_000_000
}

fn model_matches_family(model: &str, family: &str) -> bool {
    let Some(prefix) = model.get(..family.len()) else {
        return false;
    };
    if !prefix.eq_ignore_ascii_case(family) {
        return false;
    }
    match model.as_bytes().get(family.len()) {
        None => true,
        Some(next) => matches!(*next, b'-' | b'_' | b'.'),
    }
}
