import * as net from 'net';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import Fastify from 'fastify';
import cors from '@fastify/cors';

dotenv.config();

// Global error handlers to prevent the server from ever crashing
process.on('uncaughtException', (err) => {
    console.error(`[CRITICAL] Uncaught Exception:`, err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error(`[CRITICAL] Unhandled Rejection at:`, promise, `reason:`, reason);
});

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL || 'https://mdsqsnrratorpzflwwhq.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || ''; 
const supabase = supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// ==========================================
// 1. MEMORY QUEUE FOR BATCHING
// ==========================================
let batchQueue: any[] = [];
const lastIgnitionState = new Map<string, boolean>();

// This loop runs every 2 seconds to flush data to Supabase
setInterval(async () => {
    if (!supabase || batchQueue.length === 0) return;

    // Grab everything currently in the queue and clear it
    const recordsToProcess = [...batchQueue];
    batchQueue = [];

    console.log(`\n[BATCH FLUSH] Processing ${recordsToProcess.length} filtered records...`);

    try {
        // 1. Bulk Insert ALL historical records to `gps_data`
        const { error: insertErr } = await supabase.from('gps_data').insert(recordsToProcess);
        if (insertErr) {
            console.error(`[CRITICAL] Bulk Insert Failed:`, insertErr.message);
        } else {
            console.log(`[+] History Saved: ${recordsToProcess.length} rows`);
        }

        // 2. Extract only the LATEST record for each IMEI for the `gps_latest` map table
        const latestRecordsMap = new Map();
        for (const record of recordsToProcess) {
            latestRecordsMap.set(record.imei, record);
        }
        const latestRecordsArray = Array.from(latestRecordsMap.values());

        // 3. Bulk Upsert into `gps_latest`
        const { error: upsertErr } = await supabase.from('gps_latest').upsert(latestRecordsArray, { onConflict: 'imei' });
        if (upsertErr) {
            console.error(`[CRITICAL] Bulk Upsert Failed:`, upsertErr.message);
        } else {
            console.log(`[+] Live Map Updated: ${latestRecordsArray.length} devices refreshed`);
        }
    } catch (err: any) {
        console.error(`[ERROR] Background Flush Error:`, err.message);
    }
}, 2000); 

// ==========================================
// 2. TCP SOCKET SERVER (RAW GPS DEVICES)
// ==========================================
const TCP_PORT = 5112; // Hardcoded because Railway TCP proxy targets this

const server = net.createServer((socket) => {
    try {
        const clientIp = socket.remoteAddress || 'UNKNOWN_IP';
        const clientPort = socket.remotePort || 'UNKNOWN_PORT';
        
        console.log(`\n[+] [${new Date().toISOString()}] New connection established from ${clientIp}:${clientPort}`);
        socket.setTimeout(300000); // 5 minute timeout

        socket.on('data', async (data) => {
            try {
                const rawString = data.toString('ascii');
                console.log(`[INCOMING ASCII] --> ${rawString.trim()}`);
                
                // Send ACK back
                socket.write(Buffer.from([0x01]));

                // Regex to parse the Cordon / Atlanta Protocol
                const gprmcRegex = /ATL.*?(\d{15}),\$GPRMC,(\d{2})(\d{2})(\d{2})(?:\.\d+)?,([AV]),(\d+?)(\d{2}\.\d+),([NS]),(\d+?)(\d{2}\.\d+),([EW]),(\d+\.?\d*)?,(\d+\.?\d*)?,(\d{2})(\d{2})(\d{2})(.*)/;
                const match = rawString.match(gprmcRegex);

                if (!match) return;

                const imei = match[1];
                const hh = match[2];
                const mm = match[3];
                const ss = match[4];
                const validity = match[5];
                const latDeg = parseFloat(match[6]);
                const latMin = parseFloat(match[7]);
                const latHem = match[8];
                const lonDeg = parseFloat(match[9]);
                const lonMin = parseFloat(match[10]);
                const lonHem = match[11];
                const speedKnots = parseFloat(match[12] || '0');
                const course = parseFloat(match[13] || '0');
                const day = match[14];
                const month = match[15];
                const year = match[16];
                const remainder = match[17];

                if (validity !== 'A') return; // Invalid GPS fix

                // Convert to Decimal Degrees
                let latitude = latDeg + (latMin / 60.0);
                if (latHem === 'S') latitude = -latitude;

                let longitude = lonDeg + (lonMin / 60.0);
                if (lonHem === 'W') longitude = -longitude;

                const speedKmh = speedKnots * 1.852;
                
                // Timezone: IST (+05:30)
                const timestamp = new Date(`20${year}-${month}-${day}T${hh}:${mm}:${ss}+05:30`).toISOString();

                // Extract IO, Battery
                let ignition_status = false;
                let battery_voltage = null;
                try {
                    const ioMatch = remainder.match(/#([01]+),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*)/);
                    if (ioMatch) {
                        ignition_status = ioMatch[1].charAt(0) === '1'; 
                        if (ioMatch[7] && !isNaN(parseFloat(ioMatch[7]))) {
                            battery_voltage = parseFloat(ioMatch[7]);
                        }
                    }
                } catch (e) {}

                const payload = {
                    imei,
                    timestamp,
                    latitude,
                    longitude,
                    speed_kmh: speedKmh,
                    course,
                    ignition_status,
                    battery_voltage,
                    raw_data: rawString.substring(0, 255)
                };

                // SMART FILTERING for BOTH History and Live Map
                const prevIgnition = lastIgnitionState.get(imei);
                
                if (ignition_status === true || prevIgnition !== false) {
                    // Save if Ignition is ON, or if it just turned OFF (prev !== false)
                    batchQueue.push(payload);
                }
                
                // Update memory with current ignition state
                lastIgnitionState.set(imei, ignition_status);

            } catch (err: any) {
                console.error(`[ERROR] Failed to process packet:`, err.message);
            }
        });

        socket.on('error', (err: any) => console.error(`[-] Socket Error:`, err.message));
        socket.on('end', () => {});
        socket.on('close', () => {});
        socket.on('timeout', () => socket.destroy());

    } catch (serverErr: any) {
        console.error(`[CRITICAL] Error handling new connection:`, serverErr.message);
    }
});

server.listen(TCP_PORT, '0.0.0.0', () => {
    console.log(`=========================================`);
    console.log(`📡 TCP SERVER (GPS TRACKERS) Port: ${TCP_PORT}`);
});


// ==========================================
// 3. FASTIFY HTTP API (WEB & MOBILE APP)
// ==========================================
const fastify = Fastify({ logger: false });

// Enable CORS so the web frontend can call the API securely
fastify.register(cors, { origin: '*' });

// Endpoint 1: Get Live Location
fastify.get('/api/live/:imei', async (request, reply) => {
    if (!supabase) return reply.status(500).send({ error: 'Database not configured' });
    
    const { imei } = request.params as { imei: string };
    
    const { data, error } = await supabase
        .from('gps_latest')
        .select('*')
        .eq('imei', imei)
        .single();
        
    if (error) return reply.status(500).send({ error: error.message });
    if (!data) return reply.status(404).send({ error: 'Device not found or has never connected' });
    
    return data;
});

// Endpoint 2: Get Full Route Map (GeoJSON)
fastify.get('/api/route/:imei', async (request, reply) => {
    if (!supabase) return reply.status(500).send({ error: 'Database not configured' });
    
    const { imei } = request.params as { imei: string };
    const { start, end } = request.query as { start?: string, end?: string };
    
    if (!start || !end) {
        return reply.status(400).send({ error: 'Missing start or end query parameters. Example: ?start=2025-07-18T00:00:00Z&end=2025-07-18T23:59:59Z' });
    }
    
    const { data, error } = await supabase
        .from('gps_data')
        .select('*')
        .eq('imei', imei)
        .gte('timestamp', start)
        .lte('timestamp', end)
        .order('timestamp', { ascending: true });
        
    if (error) return reply.status(500).send({ error: error.message });
    if (!data || data.length === 0) return reply.status(404).send({ error: 'No route found for this time period' });
    
    // Auto-convert to a GeoJSON LineString for perfectly drawing the route on a map
    const geoJson = {
        type: "FeatureCollection",
        features: [
            {
                type: "Feature",
                properties: {},
                geometry: {
                    type: "LineString",
                    coordinates: data.map((point: any) => [point.longitude, point.latitude])
                }
            }
        ]
    };
    
    return geoJson;
});

// Endpoint 3: Get All Active Devices (Live Map)
fastify.get('/api/devices', async (request, reply) => {
    if (!supabase) return reply.status(500).send({ error: 'Database not configured' });
    
    // Fetch all rows from gps_latest (exactly 1 row per device).
    const { data, error } = await supabase
        .from('gps_latest')
        .select('*');
        
    if (error) return reply.status(500).send({ error: error.message });
    
    return data || [];
});

// Endpoint 4: Get Raw Route History Array
fastify.get('/api/history/:imei', async (request, reply) => {
    if (!supabase) return reply.status(500).send({ error: 'Database not configured' });
    
    const { imei } = request.params as { imei: string };
    const { start, end } = request.query as { start?: string, end?: string };
    
    if (!start || !end) {
        return reply.status(400).send({ error: 'Missing start or end query parameters.' });
    }
    
    const { data, error } = await supabase
        .from('gps_data')
        .select('*')
        .eq('imei', imei)
        .gte('timestamp', start)
        .lte('timestamp', end)
        .order('timestamp', { ascending: true });
        
    if (error) return reply.status(500).send({ error: error.message });
    if (!data || data.length === 0) return reply.status(404).send({ error: 'No route found for this time period' });
    
    // Map the Supabase SQL results into the exact JSON array format requested
    const rawHistory = data.map((point: any) => ({
        latitude: point.latitude,
        longitude: point.longitude,
        timestamp: point.timestamp,
        speed_kmh: point.speed_kmh,
        course: point.course,
        ignition_status: point.ignition_status
    }));
    
    return rawHistory;
});

// Start the HTTP API on Railway's public web port (usually 8080 or dynamically assigned)
const HTTP_PORT = parseInt(process.env.PORT || '8080', 10);
fastify.listen({ port: HTTP_PORT, host: '0.0.0.0' }, (err, address) => {
    if (err) {
        console.error(`[CRITICAL] HTTP API Server failed:`, err);
    } else {
        console.log(`🌐 HTTP API SERVER (FRONTEND)  URL: ${address}`);
        console.log(`=========================================`);
    }
});
