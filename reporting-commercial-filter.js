function campaignKey(row) {
  const tenantId = String(row.tenant_id ?? '').trim();
  const dispatchId = String(row.dispatch_campaign_id ?? '').trim();
  const sendyId = String(row.sendy_campaign_id ?? '').trim();

  if (!tenantId) return null;
  if (dispatchId) return `${tenantId}|dispatch|${dispatchId}`;
  if (sendyId) return `${tenantId}|sendy|${sendyId}`;
  return null;
}

async function filterCommercialCampaignRows(pool, rows) {
  const input = Array.isArray(rows) ? rows : [];
  if (input.length === 0) {
    return { rows: [], excluded: 0 };
  }

  const dispatchIds = [...new Set(
    input
      .map((row) => String(row.dispatch_campaign_id ?? '').trim())
      .filter(Boolean)
  )];

  const sendyIds = [...new Set(
    input
      .map((row) => String(row.sendy_campaign_id ?? '').trim())
      .filter(Boolean)
  )];

  if (dispatchIds.length === 0 && sendyIds.length === 0) {
    return { rows: [], excluded: input.length };
  }

  const result = await pool.query(
    `
    SELECT DISTINCT
      tm.tenant_id,
      tm.dispatch_campaign_id::text AS dispatch_campaign_id,
      tm.sendy_campaign_id::text AS sendy_campaign_id
    FROM engagement.tracking_messages tm
    WHERE tm.tenant_lead_id IS NOT NULL
      AND (
        (cardinality($1::text[]) > 0 AND tm.dispatch_campaign_id::text = ANY($1::text[]))
        OR
        (cardinality($2::text[]) > 0 AND tm.sendy_campaign_id::text = ANY($2::text[]))
      )
    `,
    [dispatchIds, sendyIds]
  );

  const allowed = new Set();

  for (const row of result.rows) {
    const tenantId = String(row.tenant_id ?? '').trim();
    const dispatchId = String(row.dispatch_campaign_id ?? '').trim();
    const sendyId = String(row.sendy_campaign_id ?? '').trim();

    if (tenantId && dispatchId) allowed.add(`${tenantId}|dispatch|${dispatchId}`);
    if (tenantId && sendyId) allowed.add(`${tenantId}|sendy|${sendyId}`);
  }

  const filtered = input.filter((row) => {
    const tenantId = String(row.tenant_id ?? '').trim();
    const dispatchId = String(row.dispatch_campaign_id ?? '').trim();
    const sendyId = String(row.sendy_campaign_id ?? '').trim();

    if (!tenantId) return false;
    if (dispatchId && allowed.has(`${tenantId}|dispatch|${dispatchId}`)) return true;
    if (sendyId && allowed.has(`${tenantId}|sendy|${sendyId}`)) return true;
    return false;
  });

  return {
    rows: filtered,
    excluded: input.length - filtered.length,
  };
}

module.exports = {
  campaignKey,
  filterCommercialCampaignRows,
};
