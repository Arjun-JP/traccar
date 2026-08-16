CREATE TABLE IF NOT EXISTS gps_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unique_id TEXT UNIQUE NOT NULL,
    name TEXT,
    model TEXT,
    status TEXT DEFAULT 'offline',
    last_online TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gps_positions (
    id BIGSERIAL PRIMARY KEY,
    device_unique_id TEXT REFERENCES gps_devices(unique_id),
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    altitude DOUBLE PRECISION,
    speed DOUBLE PRECISION,
    course DOUBLE PRECISION,
    accuracy DOUBLE PRECISION,
    fix_time TIMESTAMPTZ NOT NULL,
    attributes JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gps_positions_device_unique_id ON gps_positions(device_unique_id);
CREATE INDEX IF NOT EXISTS idx_gps_positions_fix_time ON gps_positions(fix_time DESC);

-- Enable Supabase Realtime on gps_positions
ALTER PUBLICATION supabase_realtime ADD TABLE gps_positions;
