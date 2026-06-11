// POST /api/photos
// Body: { dishes: string[], restaurantName?: string }
// Returns: { photos: { [dishName]: { url, source } } }

const { createClient } = require('@supabase/supabase-js');

const SEARCH_URL = 'https://www.googleapis.com/customsearch/v1';
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

async function getSearchPhoto(dishName, restaurantName) {
  const query = `${dishName} food dish photo`;
  const url = `${SEARCH_URL}?key=${process.env.SEARCH_API_KEY}&cx=${process.env.SEARCH_CX}&searchType=image&num=1&q=${encodeURIComponent(query)}&imgSize=medium&safe=active`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return json.items?.[0]?.link ?? null;
}

async function getPhotoForDish(dishName, restaurantName) {
  const cached = await getCachedPhoto(dishName);
  if (cached) return { url: cached.photo_url, source: cached.source };

  const mealDb = await getMealDBPhoto(dishName).catch(() => null);
  if (mealDb) {
    await setCachedPhoto(dishName, mealDb, 'mealdb');
    return { url: mealDb, source: 'mealdb' };
  }

  const search = await getSearchPhoto(dishName, restaurantName).catch(() => null);
  if (search) {
    await setCachedPhoto(dishName, search, 'search');
    return { url: search, source: 'search' };
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
