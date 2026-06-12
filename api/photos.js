// POST /api/photos
// Body: { dishes: string[], restaurantName?: string }
// Returns: { photos: { [dishName]: { url, source } } }

const { createClient } = require('@supabase/supabase-js');

const WIKI_URL = 'https://en.wikipedia.org/w/api.php';
const MEAL_DB_URL = 'https://www.themealdb.com/api/json/v1/1/search.php';

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

async function getCachedPhoto(dishName) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.from('dish_photos')
    .select('photo_url, source')
    .eq('dish_name', dishName.toLowerCase().trim())
    .single();
  return data ?? null;
}

async function setCachedPhoto(dishName, photoUrl, source) {
  const sb = getSupabase();
  if (!sb) return;
  await sb.from('dish_photos').upsert(
    { dish_name: dishName.toLowerCase().trim(), photo_url: photoUrl, source },
    { onConflict: 'dish_name' }
  );
}

async function getMealDBPhoto(dishName) {
  const res = await fetch(`${MEAL_DB_URL}?s=${encodeURIComponent(dishName)}`);
  if (!res.ok) return null;
  const json = await res.json();
  return json.meals?.[0]?.strMealThumb ?? null;
}

async function getWikipediaPhoto(dishName) {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: dishName,
    gsrlimit: '1',
    prop: 'pageimages',
    piprop: 'original',
    format: 'json',
    origin: '*',
  });
  const res = await fetch(`${WIKI_URL}?${params.toString()}`, {
    headers: { 'User-Agent': 'PeekApp/1.0 (https://peek-api.vercel.app)' },
  });
  if (!res.ok) return null;
  const json = await res.json();
  const pages = json.query?.pages ?? {};
  const page = Object.values(pages)[0];
  return page?.original?.source ?? null;
}

async function getPhotoForDish(dishName, restaurantName) {
  const cached = await getCachedPhoto(dishName);
  if (cached) return { url: cached.photo_url, source: cached.source };

  const mealDb = await getMealDBPhoto(dishName).catch(() => null);
  if (mealDb) {
    await setCachedPhoto(dishName, mealDb, 'mealdb');
    return { url: mealDb, source: 'mealdb' };
  }

  const wiki = await getWikipediaPhoto(dishName).catch(() => null);
  if (wiki) {
    await setCachedPhoto(dishName, wiki, 'wikipedia');
    return { url: wiki, source: 'wikipedia' };
  }

  return { url: null, source: 'none' };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { dishes, restaurantName } = req.body;
    if (!dishes?.length) return res.status(400).json({ error: 'dishes array required' });

    const results = await Promise.all(
      dishes.slice(0, 12).map(async (name) => {
        const photo = await getPhotoForDish(name, restaurantName);
        return { name, ...photo };
      })
    );

    const photos = {};
    results.forEach(r => { photos[r.name] = { url: r.url, source: r.source }; });

    return res.json({ photos });
  } catch (err) {
    console.error('Photos error:', err);
    return res.status(500).json({ error: err.message });
  }
};
