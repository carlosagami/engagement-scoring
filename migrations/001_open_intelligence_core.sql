BEGIN;

CREATE SCHEMA IF NOT EXISTS engagement;

CREATE TABLE IF NOT EXISTS engagement.campaigns (
    campaign_id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES control_plane.tenants(tenant_id),
    source TEXT NOT NULL,
    source_campaign_id TEXT,
    campaign_name TEXT,
    subject TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, source, source_campaign_id)
);

CREATE TABLE IF NOT EXISTS engagement.tracking_messages (
    tracking_message_id BIGSERIAL PRIMARY KEY,
    tracking_token TEXT NOT NULL UNIQUE,
    tenant_id BIGINT NOT NULL REFERENCES control_plane.tenants(tenant_id),
    campaign_id BIGINT REFERENCES engagement.campaigns(campaign_id),
    tenant_lead_id BIGINT,
    recipient_email_norm TEXT NOT NULL,
    message_id TEXT NOT NULL,
    dispatch_campaign_id TEXT,
    sendy_campaign_id TEXT,
    effective_from TEXT NOT NULL,
    sending_domain TEXT NOT NULL,
    recipient_provider TEXT,
    configuration_set TEXT,
    ses_message_id TEXT,
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    tracking_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    first_fetch_at TIMESTAMPTZ,
    last_fetch_at TIMESTAMPTZ,
    raw_fetch_count INTEGER NOT NULL DEFAULT 0,
    security_fetch_count INTEGER NOT NULL DEFAULT 0,
    proxy_fetch_count INTEGER NOT NULL DEFAULT 0,
    probable_human_fetch_count INTEGER NOT NULL DEFAULT 0,
    unknown_fetch_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, message_id, recipient_email_norm)
);

CREATE TABLE IF NOT EXISTS engagement.open_events (
    open_event_id BIGSERIAL PRIMARY KEY,
    tracking_message_id BIGINT NOT NULL REFERENCES engagement.tracking_messages(tracking_message_id) ON DELETE CASCADE,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    classification TEXT NOT NULL DEFAULT 'raw_fetch',
    classification_reason TEXT,
    human_confidence NUMERIC(5,4),
    user_agent TEXT,
    referer TEXT,
    ip_address INET,
    ip_hash TEXT,
    seconds_since_sent NUMERIC,
    seconds_since_delivery NUMERIC,
    request_fingerprint TEXT,
    cf_ray TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS engagement.open_event_classifications (
    classification_id BIGSERIAL PRIMARY KEY,
    open_event_id BIGINT NOT NULL REFERENCES engagement.open_events(open_event_id) ON DELETE CASCADE,
    classifier_version TEXT NOT NULL,
    classification TEXT NOT NULL,
    reason TEXT,
    human_confidence NUMERIC(5,4),
    classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_started
ON engagement.campaigns (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracking_messages_tenant_campaign
ON engagement.tracking_messages (tenant_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_tracking_messages_sent_at
ON engagement.tracking_messages (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracking_messages_recipient
ON engagement.tracking_messages (tenant_id, recipient_email_norm);
CREATE INDEX IF NOT EXISTS idx_open_events_tracking_message
ON engagement.open_events (tracking_message_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_open_events_classification
ON engagement.open_events (classification, occurred_at);
CREATE INDEX IF NOT EXISTS idx_open_event_classifications_event
ON engagement.open_event_classifications (open_event_id, classified_at);

CREATE TABLE IF NOT EXISTS control_plane.tenant_tracking_settings (
    tenant_id BIGINT PRIMARY KEY REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    mode TEXT NOT NULL DEFAULT 'observe',
    host_prefix TEXT NOT NULL DEFAULT 'o',
    score_probable_human_opens BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS control_plane.tenant_domain_tracking (
    tenant_domain_id BIGINT PRIMARY KEY REFERENCES control_plane.tenant_domains(tenant_domain_id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    tracking_host TEXT NOT NULL,
    dns_validated BOOLEAN NOT NULL DEFAULT FALSE,
    tls_validated BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO control_plane.tenant_tracking_settings (tenant_id, enabled, mode, host_prefix, score_probable_human_opens)
SELECT tenant_id, FALSE, 'observe', 'o', FALSE
FROM control_plane.tenants
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO control_plane.tenant_domain_tracking (tenant_domain_id, enabled, tracking_host, dns_validated, tls_validated)
SELECT tenant_domain_id, FALSE, 'o.' || domain, FALSE, FALSE
FROM control_plane.tenant_domains
WHERE is_enabled = TRUE
ON CONFLICT (tenant_domain_id) DO NOTHING;

COMMIT;
