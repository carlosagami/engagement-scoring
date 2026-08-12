const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const SERVICE_NAME = process.env.TRACKING_SERVICE_NAME || 'poweremail-open-intelligence';
const POSTGRES_SERVICE_NAME = process.env.POSTGRES_SERVICE_NAME || 'Postgres';
const CF_API = 'https://api.cloudflare.com/client/v4';
const POLL_MS = Number(process.env.TRACKING_DOMAIN_POLL_MS || 15000);
const POLL_ATTEMPTS = Number(process.env.TRACKING_DOMAIN_POLL_ATTEMPTS || 40);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function runJson(cmd, args) {
  const out = run(cmd, args);
  return out ? JSON.parse(out) : null;
}

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function findNamedObject(root, name) {
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);
    if (String(value.name || '') === name && value.id) return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    for (const child of Object.values(value)) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  }
  return walk(root);
}

function getRailwayContext() {
  const status = runJson('railway', ['status', '--json']);
  const projectId =
    status?.project?.id ||
    status?.id ||
    status?.projectId ||
    process.env.RAILWAY_PROJECT_ID;

  const environmentObj =
    status?.environment ||
    findNamedObject(status, process.env.RAILWAY_ENVIRONMENT_NAME || 'production');
  const environmentId =
    environmentObj?.id || status?.environmentId || process.env.RAILWAY_ENVIRONMENT_ID;

  const serviceObj =
    status?.service ||
    findNamedObject(status, SERVICE_NAME);
  const serviceId =
    serviceObj?.id || status?.serviceId || process.env.RAILWAY_SERVICE_ID;

  if (!projectId || !environmentId || !serviceId) {
    throw new Error(
      `Unable to resolve Railway context. Ensure the CLI is linked to project/environment/service ${SERVICE_NAME}.`
    );
  }

  return { projectId, environmentId, serviceId };
}

function extractVariable(json, key) {
  if (!json) return null;
  if (typeof json[key] === 'string') return json[key];
  if (json[key] && typeof json[key].value === 'string') return json[key].value;
  if (Array.isArray(json)) {
    const row = json.find((x) => x?.name === key || x?.key === key);
    if (row) return row.value || row.currentValue || null;
  }
  for (const value of Object.values(json)) {
    if (value && typeof value === 'object') {
      const found = extractVariable(value, key);
      if (found) return found;
    }
  }
  return null;
}

function resolveDatabaseUrl() {
  for (const key of ['PSQL_LEADS_URL', 'DATABASE_PUBLIC_URL']) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }

  const vars = runJson('railway', ['variables', '--service', POSTGRES_SERVICE_NAME, '--json']);
  const value = extractVariable(vars, 'DATABASE_PUBLIC_URL');
  if (!value) {
    throw new Error(
      `Unable to resolve DATABASE_PUBLIC_URL from Railway service ${POSTGRES_SERVICE_NAME}.`
    );
  }
  return value;
}

async function cfRequest(path, options = {}) {
  const token = requireEnv('CF_API_TOKEN');
  const response = await fetch(`${CF_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok || body.success === false) {
    throw new Error(`Cloudflare API error ${response.status}: ${JSON.stringify(body.errors || body)}`);
  }
  return body;
}

async function getZone(domain) {
  const body = await cfRequest(`/zones?name=${encodeURIComponent(domain)}`);
  const zone = body.result?.find((z) => z.name === domain);
  if (!zone) throw new Error(`Cloudflare zone not found: ${domain}`);
  return zone;
}

async function upsertCfRecord(zoneId, type, name, content, proxied = false) {
  const lookup = await cfRequest(
    `/zones/${zoneId}/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`
  );
  const existing = lookup.result?.[0];
  const payload = {
    type,
    name,
    content,
    ttl: 1,
  };
  if (type === 'CNAME') payload.proxied = proxied;

  if (existing) {
    await cfRequest(`/zones/${zoneId}/dns_records/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    return { action: 'updated', id: existing.id };
  }

  const created = await cfRequest(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return { action: 'created', id: created.result.id };
}

const DOMAINS_QUERY = `
query Domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
  domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
    customDomains {
      id
      domain
      status {
        verified
        verificationDnsHost
        verificationToken
        certificateStatus
        dnsRecords {
          recordType
          hostlabel
          fqdn
          requiredValue
          currentValue
          status
          zone
          purpose
        }
      }
    }
  }
}`;

function railwayDomains(context) {
  const variables = JSON.stringify(context);
  const result = runJson('railway', [
    'api',
    DOMAINS_QUERY,
    '--variables',
    variables,
    '--compact',
  ]);
  return result?.data?.domains?.customDomains || [];
}

function getRailwayDomain(context, hostname) {
  return railwayDomains(context).find((d) => d.domain === hostname) || null;
}

function ensureRailwayCustomDomain(hostname) {
  try {
    run('railway', ['domain', hostname, '--json', '--service', SERVICE_NAME]);
  } catch (error) {
    const stderr = String(error.stderr || '');
    if (!/already|exists|in use/i.test(stderr)) throw error;
  }
}

function getRoutingRecord(customDomain) {
  const records = customDomain?.status?.dnsRecords || [];
  return (
    records.find((r) => String(r.recordType || '').toUpperCase() === 'CNAME') ||
    records.find((r) => String(r.requiredValue || '').includes('railway.app')) ||
    records[0] ||
    null
  );
}

async function waitForRailway(context, hostname) {
  let last = null;
  for (let i = 0; i < POLL_ATTEMPTS; i += 1) {
    last = getRailwayDomain(context, hostname);
    const verified = last?.status?.verified === true;
    const cert = String(last?.status?.certificateStatus || '');
    if (verified && /ISSUED|ACTIVE|VALID/i.test(cert)) return last;
    if (verified && !cert) return last;
    await sleep(POLL_MS);
  }
  return last;
}

async function probe(hostname) {
  try {
    const response = await fetch(`https://${hostname}/health`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.text();
    return {
      ok: response.status === 200 && /poweremail-open-intelligence/.test(body),
      status: response.status,
      server: response.headers.get('server'),
      body: body.slice(0, 300),
    };
  } catch (error) {
    return { ok: false, status: null, server: null, body: error.message };
  }
}

async function listDomains(pool, onlyDomain) {
  const params = [];
  let filter = '';
  if (onlyDomain) {
    params.push(onlyDomain.toLowerCase());
    filter = `AND lower(td.domain) = $1`;
  }
  const { rows } = await pool.query(
    `SELECT
       t.tenant_id,
       t.tenant_key,
       td.tenant_domain_id,
       lower(td.domain) AS domain,
       tdt.tracking_host,
       tdt.enabled,
       tdt.dns_validated,
       tdt.tls_validated
     FROM control_plane.tenant_domains td
     JOIN control_plane.tenants t ON t.tenant_id = td.tenant_id
     JOIN control_plane.tenant_domain_tracking tdt
       ON tdt.tenant_domain_id = td.tenant_domain_id
     WHERE td.is_enabled = TRUE
       ${filter}
     ORDER BY t.tenant_key, td.domain`,
    params
  );
  return rows;
}

async function updateDomainState(pool, tenantDomainId, dnsValidated, tlsValidated) {
  await pool.query(
    `UPDATE control_plane.tenant_domain_tracking
     SET dns_validated = $2,
         tls_validated = $3,
         updated_at = NOW()
     WHERE tenant_domain_id = $1`,
    [tenantDomainId, dnsValidated, tlsValidated]
  );
}

async function provisionOne(pool, context, row) {
  const hostname = row.tracking_host || `o.${row.domain}`;
  console.log(`\n[DOMAIN] ${row.tenant_key} ${row.domain} -> ${hostname}`);

  ensureRailwayCustomDomain(hostname);

  let railwayDomain = getRailwayDomain(context, hostname);
  if (!railwayDomain) throw new Error(`Railway custom domain not visible after create: ${hostname}`);

  const routing = getRoutingRecord(railwayDomain);
  const cnameTarget = routing?.requiredValue;
  const verificationHost = railwayDomain.status?.verificationDnsHost || `_railway-verify.${hostname}`;
  const verificationToken = railwayDomain.status?.verificationToken;

  if (!cnameTarget) throw new Error(`Railway did not return CNAME target for ${hostname}`);
  if (!verificationToken) throw new Error(`Railway did not return verificationToken for ${hostname}`);

  const zone = await getZone(row.domain);

  const cnameResult = await upsertCfRecord(zone.id, 'CNAME', hostname, cnameTarget, true);
  const txtResult = await upsertCfRecord(zone.id, 'TXT', verificationHost, verificationToken, false);

  console.log(`[CF] CNAME ${cnameResult.action}: ${hostname} -> ${cnameTarget}`);
  console.log(`[CF] TXT ${txtResult.action}: ${verificationHost}`);

  railwayDomain = await waitForRailway(context, hostname);
  const dnsValidated = railwayDomain?.status?.verified === true;
  const certificateStatus = String(railwayDomain?.status?.certificateStatus || '');
  const tlsValidated = /ISSUED|ACTIVE|VALID/i.test(certificateStatus) || (dnsValidated && !certificateStatus);

  const health = await probe(hostname);
  await updateDomainState(pool, row.tenant_domain_id, dnsValidated, health.ok && tlsValidated);

  console.log('[RAILWAY]', {
    verified: dnsValidated,
    certificateStatus: certificateStatus || null,
  });
  console.log('[HEALTH]', health);

  return {
    tenant: row.tenant_key,
    domain: row.domain,
    hostname,
    dnsValidated,
    tlsValidated: health.ok && tlsValidated,
    healthStatus: health.status,
  };
}

async function main() {
  requireEnv('CF_API_TOKEN');
  run('railway', ['whoami']);

  const onlyDomain = process.argv.find((arg) => !arg.startsWith('-') && arg !== process.argv[1]);
  const context = getRailwayContext();
  const databaseUrl = resolveDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, max: 2 });

  try {
    const rows = await listDomains(pool, onlyDomain);
    if (!rows.length) throw new Error(onlyDomain ? `No enabled tenant domain found for ${onlyDomain}` : 'No tracking domains found');

    const results = [];
    for (const row of rows) {
      try {
        results.push(await provisionOne(pool, context, row));
      } catch (error) {
        console.error(`[ERROR] ${row.domain}: ${error.message}`);
        results.push({ tenant: row.tenant_key, domain: row.domain, error: error.message });
      }
    }

    console.log('\n[SUMMARY]');
    for (const result of results) console.log(result);

    if (results.some((r) => r.error || !r.dnsValidated || !r.tlsValidated)) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[FATAL]', error.message);
  process.exit(1);
});
