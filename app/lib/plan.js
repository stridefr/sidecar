// Real plan usage — the same numbers Claude Code shows in its own "Session
// (5hr) / Weekly (7 day)" panel. It caches them in ~/.claude.json under
// cachedUsageUtilization, so Sidecar reads that file rather than calling any
// API or touching credentials.
//
// It is a *cache*: Claude Code refreshes it when it talks to the API, so the
// figures can be stale if the CLI hasn't run in a while. fetchedAtMs is
// surfaced so the UI can say how old they are instead of implying live data.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.claude.json');

const LABELS = {
  session: 'Session',
  weekly_all: 'Weekly',
  weekly_scoped: 'Weekly (model)',
};

function prettyTier(tier) {
  if (!tier) return null;
  return String(tier)
    .replace(/^default_/, '')
    .replace(/_/g, ' ')
    .replace(/\bclaude\b/i, 'Claude')
    .replace(/\bmax\b/i, 'Max')
    .replace(/\bpro\b/i, 'Pro')
    .trim();
}

function readPlan() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return { available: false, reason: 'Could not read ~/.claude.json' };
  }

  const cached = cfg.cachedUsageUtilization;
  if (!cached || !cached.utilization) {
    return { available: false, reason: 'No usage data cached yet — run Claude Code once.' };
  }

  const u = cached.utilization;
  const rawLimits = Array.isArray(u.limits) ? u.limits : [];

  // Prefer the limits[] array (what the CLI's own panel renders); fall back to
  // the flat five_hour / seven_day objects if a future build drops it.
  let limits = rawLimits
    .filter((l) => l && typeof l.percent === 'number')
    .map((l) => ({
      key: l.kind,
      label: LABELS[l.kind] || l.kind,
      scope: l.scope?.model?.display_name || null,
      percent: l.percent,
      severity: l.severity || 'normal',
      resetsAt: l.resets_at || null,
      isActive: !!l.is_active,
    }));

  if (!limits.length) {
    const flat = [
      ['session', 'Session', u.five_hour],
      ['weekly_all', 'Weekly', u.seven_day],
    ];
    limits = flat
      .filter(([, , v]) => v && typeof v.utilization === 'number')
      .map(([key, label, v]) => ({
        key, label, scope: null,
        percent: v.utilization,
        severity: 'normal',
        resetsAt: v.resets_at || null,
        isActive: v.utilization > 0,
      }));
  }

  const extra = u.extra_usage || null;

  return {
    available: true,
    fetchedAtMs: cached.fetchedAtMs || null,
    tier: prettyTier(cfg.oauthAccount?.organizationRateLimitTier),
    limits,
    extraUsage: extra ? {
      enabled: !!extra.is_enabled,
      usedCredits: extra.used_credits || 0,
      monthlyLimit: extra.monthly_limit || 0,
      currency: extra.currency || 'USD',
      decimalPlaces: typeof extra.decimal_places === 'number' ? extra.decimal_places : 2,
      disabledReason: extra.disabled_reason || null,
    } : null,
  };
}

module.exports = { readPlan, CONFIG_PATH };
