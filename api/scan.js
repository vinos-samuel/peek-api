// POST /api/scan
// Body: { imageBase64: string, restaurantName?: string }
// Returns: { dishes: [{ originalName, englishName, price, section, photoUrl, photoSource }] }

// Increase body size limit to 10MB for base64 images
module.exports.config = { api: { bodyParser: { sizeLimit: '10mb' } } };

const { createClient } = require('@supabase/supabase-js');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const SEARCH_URL = 'https://www.googleapis.com/customsearch/v1';
const MEAL_DB_URL = 'https://www.themealdb.com/api/json/v1/1/search.php';

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

// ── Step 1: Extract dishes from menu image via Gemini ─────────────────────
async function extractDishes(imageBase64) {
  const res = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            text: `You are a menu reader. Extract every dish name from this menu photo.
Return ONLY a JSON array. Each item must have:
- "originalName": exact text from menu
- "englishName": plain English name (translate if needed, keep concise)
- "price": price string if visible (else omit)
- "section": menu section heading if visible (else omit)
No markdown. No explanation. JSON array only.`
          },
          {
            inline_data: { mime_type: 'image/jpeg', data: imageBase64 }
          }
        ]
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 1024 }
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error ${res.status}: ${err}`);
  }

  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
}

// ── Step 2a: Check Supabase cache ─────────────────────────────────────────
async function getCachedPhoto(dishName) {
  const sb = getSupabase();
  if (!sb) return null;
  const key = dishName.toLowerCase().trim();
  const { data } = await sb.from('dish_photos').select('photo_url, source').eq('dish_name', key).single();
  return data ?? null;
}

async function setCachedPhoto(dishName, photoUrl, source) {
  const sb = getSupabase();
  if (!sb) return;
  const key = dishName.toLowerCase().trim();
  await sb.from('dish_photos').upsert({ dish_name: key, photo_url: photoUrl, source }, { onConflict: 'dish_name' });
}

// ── Step 2b: TheMealDB — free, food-specific ──────────────────────────────
async function getMealDBPhoto(dishName) {
  const res = await fetch(`${MEAL_DB_URL}?s=${encodeURIComponent(dishName)}`);
  if (!res.ok) return null;
  const json = await res.json();
  return json.meals?.[0]?.strMealThumb ?? null;
}

// ── Step 2c: Google Custom Search fallback ────────────────────────────────
async function getSearchPhoto(dishName, restaurantName) {
  const query = restaurantName
    ? `${dishName} ${restaurantName} food dish`
    : `${dishName} food dish photo`;

  const url = `${SEARCH_URL}?key=${process.env.SEARCH_API_KEY}&cx=${process.env.SEARCH_CX}&searchType=image&num=1&q=${encodeURIComponent(query)}&imgSize=medium&safe=active`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return json.items?.[0]?.link ?? null;
}

// ── Step 2: Get photo for one dish ────────────────────────────────────────
async function getPhotoForDish(dishName, restaurantName) {
  // 1. Cache
  const cached = await getCachedPhoto(dishName);
  if (cached) return cached;

  // 2. TheMealDB (free, no quota)
  const mealDb = await getMealDBPhoto(dishName).catch(() => null);
  if (mealDb) {
    await setCachedPhoto(dishName, mealDb, 'mealdb');
    return { photo_url: mealDb, source: 'mealdb' };
  }

  // 3. Google Custom Search fallback
  const search = await getSearchPhoto(dishName, restaurantName).catch(() => null);
  if (search) {
    await setCachedPhoto(dishName, search, 'search');
    return { photo_url: search, source: 'search' };
  }

  return { photo_url: null, source: 'none' };
}

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageBase64, restaurantName } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

    // Extract dishes
    const dishes = await extractDishes(imageBase64);
    if (!dishes.length) return res.json({ dishes: [] });

    // Cap at 12 dishes to control cost
    const capped = dishes.slice(0, 12);

    // Fetch photos in parallel
    const photos = await Promise.all(
      capped.map(d => getPhotoForDish(d.englishName, restaurantName))
    );

    const result = capped.map((d, i) => ({
      ...d,
      photoUrl: photos[i].photo_url,
      photoSource: photos[i].source,
    }));

    return res.json({ dishes: result });

  } catch (err) {
    console.error('Scan error:', err);
    return res.status(500).json({ error: err.message });
  }
};
