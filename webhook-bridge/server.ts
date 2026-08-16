import Fastify from 'fastify';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const fastify = Fastify({ logger: true });

// Traccar webhook endpoint
fastify.post('/api/traccar/webhook', async (request, reply) => {
  try {
    const payload = request.body as any;

    if (!payload || !payload.position || !payload.device) {
      reply.status(400).send({ error: "Invalid payload format. Expected { position, device }" });
      return;
    }

    const { position, device } = payload;
    const uniqueId = device.uniqueId;
    const { latitude, longitude, altitude, speed, course, accuracy, fixTime, attributes } = position;

    // 1. Upsert device to ensure it exists and update its status
    const { error: deviceError } = await supabase
      .from('gps_devices')
      .upsert({
        unique_id: uniqueId,
        name: device.name || null,
        model: device.model || null,
        status: 'online',
        last_online: new Date().toISOString()
      }, { onConflict: 'unique_id' });

    if (deviceError) {
      fastify.log.error({ err: deviceError }, "Error upserting device");
      reply.status(500).send({ error: "Failed to upsert device" });
      return;
    }

    // 2. Insert the new position
    const { error: positionError } = await supabase
      .from('gps_positions')
      .insert({
        device_unique_id: uniqueId,
        latitude,
        longitude,
        altitude,
        speed,
        course,
        accuracy,
        fix_time: fixTime,
        attributes
      });

    if (positionError) {
      fastify.log.error({ err: positionError }, "Error inserting position");
      reply.status(500).send({ error: "Failed to insert position" });
      return;
    }

    reply.status(200).send({ success: true });
  } catch (error) {
    fastify.log.error(error, "Webhook processing error");
    reply.status(500).send({ error: "Internal server error" });
  }
});

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    await fastify.listen({ port: port, host: '0.0.0.0' });
    fastify.log.info(`Server listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
