module.exports = (req, res) => {
  res.json({
    status: 'ok',
    keys: {
      gemini: !!process.env.GEMINI_API_KEY,
      search: !!process.env.SEARCH_API_KEY,
      supabase: !!process.env.SUPABASE_URL,
    }
  });
};
