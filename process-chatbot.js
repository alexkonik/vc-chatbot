const { createClient } = require('@supabase/supabase-js');
const { runPipeline } = require('./pipeline');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function processNewChatbotEntries() {
  console.log('⏳ Checking for new chatbot entries...');
  const { data: entries, error } = await supabase
    .from('chatbot')
    .select('*')
    .is('status', null)          // only rows that haven't been processed
    .order('created_at', { ascending: true })
    .limit(10);                  // process in batches

  if (error) {
    console.error('Error fetching chatbot entries:', error);
    return;
  }

  if (!entries?.length) {
    console.log('No new entries.');
    return;
  }

  for (const entry of entries) {
    console.log(`Processing entry from ${entry.created_at}...`);
    try {
      const result = await runPipeline({
        region: entry.region,
        country: entry.country,
        client_type: entry.client_type,
        service: entry.service,
      });
      console.log(`Result: ${result}`);
      // Mark as processed
      await supabase
        .from('chatbot')
        .update({ status: 'vybavene' })
        .eq('id', entry.id);
    } catch (err) {
      console.error(`Failed to process entry ${entry.id}:`, err);
      // optionally mark as failed
      await supabase
        .from('chatbot')
        .update({ status: 'failed' })
        .eq('id', entry.id);
    }
  }
}

processNewChatbotEntries();