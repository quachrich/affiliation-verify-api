const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { verifyAffiliation } = require('../services/verifier');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

router.post('/verify', async (req, res) => {
  try {
    const { name, institution, department, title } = req.body;

    if (!name || !institution) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['name', 'institution']
      });
    }

    if (name.length > 255 || institution.length > 255) {
      return res.status(400).json({ error: 'Input too long' });
    }

    const cached = await checkCache(pool, name, institution);
    if (cached) {
      return res.json({ ...formatCachedResult(cached), cached: true });
    }

    const result = await verifyAffiliation(name, institution, department, title);
    await saveVerification(pool, name, institution, department, title, result);

    res.json(result);
  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).json({ error: 'Verification failed', message: err.message });
  }
});

router.get('/verify/history/:name/:institution', async (req, res) => {
  try {
    const { name, institution } = req.params;
    const result = await pool.query(
      'SELECT * FROM verification_requests WHERE name = $1 AND institution = $2 ORDER BY created_at DESC LIMIT 10',
      [name, institution]
    );
    res.json({ results: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Query failed' });
  }
});

async function checkCache(pool, name, institution) {
  try {
    const result = await pool.query(
      'SELECT * FROM verification_requests WHERE name = $1 AND institution = $2 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [name, institution]
    );
    return result.rows[0] || null;
  } catch (err) {
    return null;
  }
}

function formatCachedResult(row) {
  return {
    confidence: row.confidence,
    verified: row.verified,
    status: row.status,
    evidence: row.evidence || [],
    flags: row.flags || [],
    sources: row.sources || {},
    queriedAt: row.created_at
  };
}

async function saveVerification(pool, name, institution, department, title, result) {
  try {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO verification_requests (name, institution, department, title, confidence, verified, status, sources, evidence, flags, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        name,
        institution,
        department || null,
        title || null,
        result.confidence,
        result.verified,
        result.status,
        JSON.stringify(result.sources || {}),
        JSON.stringify(result.evidence || []),
        JSON.stringify(result.flags || []),
        expiresAt
      ]
    );
  } catch (err) {
    console.error('Failed to save verification:', err.message);
  }
}

module.exports = router;
