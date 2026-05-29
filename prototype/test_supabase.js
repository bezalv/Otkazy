import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { data, error, count } = await supabase
  .from('lost_deals')
  .select('*', { count: 'exact', head: true });
console.log('error:', error);
console.log('count:', count);
