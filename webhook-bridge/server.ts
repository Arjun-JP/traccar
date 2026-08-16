import net from 'net';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL || 'https://mdsqsnrratorpzflwwhq.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || ''; 

// If they didn't provide keys, we just log it for now
const supabase = supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const PORT = parseInt(process.env.PORT || '5112', 10);

const server = net.createServer((socket) => {
    console.log(`\n[+] New connection established from ${socket.remoteAddress}:${socket.remotePort}`);

    socket.on('data', async (data) => {
        try {
            const rawString = data.toString('ascii');
            console.log(`\n[INCOMING RAW DATA] --> ${rawString.trim()}`);
            
            // Send ACK back (Traccar sends a single 0x01 byte)
            socket.write(Buffer.from([0x01]));

            // Regex to parse the Cordon / Atlanta Protocol
            // Example: ATL862211072207855,$GPRMC,133409,A,1232.9652,N,07757.4297,E,0.0,0,180725,,,*2A,#01111011000000,0.00,-70.00,,14940.32,33,4.2...
            const gprmcRegex = /ATL.*?(\d{15}),\$GPRMC,(\d{2})(\d{2})(\d{2})(?:\.\d+)?,([AV]),(\d+?)(\d{2}\.\d+),([NS]),(\d+?)(\d{2}\.\d+),([EW]),(\d+\.?\d*)?,(\d+\.?\d*)?,(\d{2})(\d{2})(\d{2})(.*)/;
            const match = rawString.match(gprmcRegex);

            if (!match) {
                console.log(`[-] Could not parse data: ${rawString.substring(0, 50)}...`);
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

            // Only process valid fixes
            if (validity !== 'A') {
                console.log(`[!] Invalid GPS fix for ${imei}`);
                return;
            }

            // Convert to Decimal Degrees
            let latitude = latDeg + (latMin / 60.0);
            if (latHem === 'S') latitude = -latitude;

            let longitude = lonDeg + (lonMin / 60.0);
            if (lonHem === 'W') longitude = -longitude;

            const speedKmh = speedKnots * 1.852;

            // Parse Date (Format: 20YY-MM-DDTHH:MM:SSZ)
            const timestamp = new Date(`20${year}-${month}-${day}T${hh}:${mm}:${ss}Z`).toISOString();

            // Extract IO, Battery, etc from remainder
            let ignition_status = false;
            let battery_voltage = null;

            const ioMatch = remainder.match(/#([01]+),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*)/);
            if (ioMatch) {
                const ioField = ioMatch[1];
                ignition_status = ioField.charAt(0) === '1'; // 0th bit is Ignition
                
                // Usually Battery is the 7th field after # in Atlanta protocol (or we can extract it if present)
                if (ioMatch[7]) {
                    battery_voltage = parseFloat(ioMatch[7]);
                }
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
                raw_data: rawString.substring(0, 255) // Keep a snippet for debugging
            };

            console.log(`[+] Valid Location: ${imei} | Lat: ${latitude} | Lon: ${longitude} | Speed: ${speedKmh}`);

            if (supabase) {
                const { error } = await supabase.from('gps_data').insert([payload]);
                if (error) {
                    console.error(`[-] Supabase Insert Error:`, error);
                } else {
                    console.log(`[+] Saved to Supabase!`);
                }
            } else {
                console.log(`[!] Supabase not configured. Set SUPABASE_URL and SUPABASE_KEY in Railway!`);
            }

        } catch (err) {
            console.error(`[-] Error processing packet:`, err);
        }
    });

    socket.on('error', (err) => {
        console.error(`[-] Socket Error from ${socket.remoteAddress}:`, err.message);
    });

    socket.on('close', () => {
        console.log(`[-] Connection closed by ${socket.remoteAddress}`);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Custom GPS Server listening on port ${PORT}`);
});
