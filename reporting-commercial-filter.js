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
    return { rows: input, excluded: 0 };
  }

  const result = await pool.query(
    `
    SELECT
      r.tenant_id,
      r.dispatch_campaign_id::text AS dispatch_campaign_id,
      r.sendy_campaign_id::text AS sendy_campaign_id,
      r.source_system,
      COALESCE((r.sendy_snapshot_json ->> 'test_parent_alias')::boolean, false) AS test_parent_alias,
      COALESCE((r.sendy_snapshot_json ->> 'test_reserve_mirror')::boolean, false) AS test_reserve_mirror
    FROM control_plane.sendy_campaign_registry r
    WHERE
      (cardinality($1::text[]) > 0 AND r.dispatch_campaign_id::text = ANY($1::text[]))
      OR
      (cardinality($2::text[]) > 0 AND r.sendy_campaign_id::text = ANY($2::text[]))
    `,
    [dispatchIds, sendyIds]
  );

  const excludedKeys = new Set();

  for (const row of result.rows) {
    const sourceSystem = String(row.source_system || '').trim().toLowerCase();
    const isControlSend =
      sourceSystem.startsWith('poweremail-test-') ||
      row.test_parent_alias === true ||
      row.test_reserve_mirror === true;

    if (!isControlSend) continue;

    const tenantId = String(row.tenant_id ?? '').trim();
    const dispatchId = String(row.dispatch_campaign_id ?? '').trim();
    const sendyId = String(row.sendy_campaign_id ?? '').trim();

    if (tenantId && dispatchId) {
      excludedKeys.add(`${tenantId}|dispatch|${dispatchId}`);
    }

    if (tenantId && sendyId) {
      excludedKeys.add(`${tenantId}|sendy|${sendyId}`);
    }
  }

  const filtered = input.filter((row) => {
    const tenantId = String(row.tenant_id ?? '').trim();
    const dispatchId = String(row.dispatch_campaign_id ?? '').trim();
    const sendyId = String(row.sendy_campaign_id ?? '').trim();

    if (tenantId && dispatchId && excludedKeys.has(`${tenantId}|dispatch|${dispatchId}`)) {
      return false;
    }

    if (tenantId && sendyId && excludedKeys.has(`${tenantId}|sendy|${sendyId}`)) {
      return false;
    }

    return true;
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
