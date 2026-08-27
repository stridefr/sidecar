// Cost estimate from token counts. Cache-write and cache-read multipliers are
// Anthropic's published ratios relative to base input price (5-minute cache
// writes cost 1.25x, 1-hour writes 2x, cache reads 0.1x) — applied here per
// model rather than hard-coded to one, since a transcript can span models.
const RATES = {
  'claude-opus-5':   { in: 5,  out: 25 },
  'claude-opus-4-8': { in: 5,  out: 25 },
  'claude-opus-4-7': { in: 5,  out: 25 },
  'claude-opus-4-6': { in: 5,  out: 25 },
  'claude-sonnet-5': { in: 2,  out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-fable-5':  { in: 10, out: 50 },
};
const DEFAULT_RATE = RATES['claude-opus-5'];
const PER_MTOK = 1_000_000;

function rateFor(model) {
  return RATES[model] || DEFAULT_RATE;
}

// usage: {input_tokens, output_tokens, cache_creation:{ephemeral_5m_input_tokens,ephemeral_1h_input_tokens}, cache_read_input_tokens}
function costOf(usage, model) {
  const r = rateFor(model);
  const cw5 = usage.cache_creation?.ephemeral_5m_input_tokens || 0;
  const cw1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
  const cwOther = Math.max(0, (usage.cache_creation_input_tokens || 0) - cw5 - cw1h);
  const cr = usage.cache_read_input_tokens || 0;

  const inCost   = (usage.input_tokens || 0) * (r.in / PER_MTOK);
  const outCost  = (usage.output_tokens || 0) * (r.out / PER_MTOK);
  const cw5Cost  = cw5 * (r.in * 1.25 / PER_MTOK);
  const cw1hCost = cw1h * (r.in * 2 / PER_MTOK);
  const cwOtherCost = cwOther * (r.in * 1.25 / PER_MTOK); // assume 5m if the split isn't present
  const crCost   = cr * (r.in * 0.1 / PER_MTOK);

  return inCost + outCost + cw5Cost + cw1hCost + cwOtherCost + crCost;
}

module.exports = { costOf, rateFor };
