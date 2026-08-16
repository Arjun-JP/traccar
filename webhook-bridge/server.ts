import net from 'net';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

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

// Hardcode port 5112
const PORT = 5112;

const server = net.createServer((socket) => {
    try {
        const clientIp = socket.remoteAddress || 'UNKNOWN_IP';
        const clientPort = socket.remotePort || 'UNKNOWN_PORT';
        
        console.log(`\n[+] [${new Date().toISOString()}] New connection established from ${clientIp}:${clientPort}`);

        // Set a timeout so dead connections don't hang open forever (e.g., 5 minutes)
        socket.setTimeout(300000);

        socket.on('data', async (data) => {
            try {
                // Log the exact raw hex bytes in case it's not ASCII text
                console.log(`[RAW HEX BUFFER] -->`, data.toString('hex'));

                const rawString = data.toString('ascii');
                console.log(`[INCOMING ASCII] --> ${rawString.trim()}`);
                
                // Send ACK back (Traccar sends a single 0x01 byte)
                socket.write(Buffer.from([0x01]));

                // Regex to parse the Cordon / Atlanta Protocol
                const gprmcRegex = /ATL.*?(\d{15}),\$GPRMC,(\d{2})(\d{2})(\d{2})(?:\.\d+)?,([AV]),(\d+?)(\d{2}\.\d+),([NS]),(\d+?)(\d{2}\.\d+),([EW]),(\d+\.?\d*)?,(\d+\.?\d*)?,(\d{2})(\d{2})(\d{2})(.*)/;
                const match = rawString.match(gprmcRegex);

                if (!match) {
                    console.warn(`[-] Could not parse GPS data format. Payload: ${rawString.substring(0, 100)}...`);
                    return;
                }

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

                if (validity !== 'A') {
                    console.warn(`[!] GPS Fix Invalid (V) for IMEI ${imei}. Device might be indoors or searching for satellites.`);
                    return;
                }

                // Convert to Decimal Degrees
                let latitude = latDeg + (latMin / 60.0);
                if (latHem === 'S') latitude = -latitude;

                let longitude = lonDeg + (lonMin / 60.0);
                if (lonHem === 'W') longitude = -longitude;

                const speedKmh = speedKnots * 1.852;
                const timestamp = new Date(`20${year}-${month}-${day}T${hh}:${mm}:${ss}Z`).toISOString();

                // Extract IO, Battery, etc from remainder
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
                } catch (parseErr) {
                    console.error(`[-] Error parsing I/O and Battery fields:`, parseErr);
                }

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

                console.log(`[+] SUCCESS | IMEI: ${imei} | Lat: ${latitude} | Lon: ${longitude} | Speed: ${speedKmh} km/h`);

                if (supabase) {
                    const { error } = await supabase.from('gps_data').insert([payload]);
                    if (error) {
                        console.error(`[CRITICAL] Database Insert Failed:`, error.message, error.details);
                    } else {
                        console.log(`[+] Data securely saved to Supabase!`);
                    }
                } else {
                    console.warn(`[!] Supabase client not initialized. Missing API Keys in environment!`);
                }

            } catch (err: any) {
                console.error(`[ERROR] Failed to process packet:`, err.message);
            }
        });

        socket.on('error', (err: any) => {
            console.error(`[-] Socket Error from ${clientIp}:`, err.message);
        });

        socket.on('end', () => {
            console.log(`[-] Socket End: Connection closed gracefully by ${clientIp}`);
        });

        socket.on('close', (hadError) => {
            console.log(`[-] Socket Closed: ${clientIp} (Had Error: ${hadError})`);
        });

        socket.on('timeout', () => {
            console.warn(`[!] Socket Timeout: Connection from ${clientIp} was idle for too long. Disconnecting.`);
            socket.destroy();
        });

    } catch (serverErr: any) {
        console.error(`[CRITICAL] Error handling new connection:`, serverErr.message);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`=========================================`);
    console.log(`🚀 MAXIMUM LOGGING GPS SERVER RUNNING`);
    console.log(`📡 Listening on Port: ${PORT}`);
    console.log(`=========================================`);
});
