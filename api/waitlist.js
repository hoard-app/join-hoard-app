// api/waitlist.js — Vercel Serverless Function

const LOOPS_API_KEY = process.env.LOOPS_API_KEY;
const LOOPS_TRANSACTIONAL_ID = process.env.LOOPS_TRANSACTIONAL_ID;
const LOOPS_BADGE_TRANSACTIONAL_ID = process.env.LOOPS_BADGE_TRANSACTIONAL_ID;
const BASE_URL = process.env.BASE_URL;

const BADGE_MILESTONES = { 1: "bronze", 2: "silver", 3: "gold" };

function getBadge(referralCount) {
  const earned = Object.entries(BADGE_MILESTONES)
    .filter(([threshold]) => referralCount >= Number(threshold))
    .map(([, badge]) => badge);
  return earned.length ? earned[earned.length - 1] : null;
}

// Short deterministic code from email — used as both referral code and Loops userId
function generateReferralCode(email) {
  let hash = 0;
  const str = email.toLowerCase().trim();
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36).toUpperCase().slice(0, 7);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, referredBy } = req.body;

  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Valid email required" });
  }

  const referralCode = generateReferralCode(email);
  const referralLink = `${BASE_URL}?ref=${referralCode}`;

  try {
    // 1. Create contact — store referralCode as userId for fast lookup later
    const createRes = await fetch("https://app.loops.so/api/v1/contacts/create", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOOPS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        userId: referralCode,   // ← key: enables fast find?userId= lookup
        source: "waitlist",
        subscribed: true,
        referralLink,
        referredBy: referredBy || "",
        referralCount: 0,
        badge: "",
      }),
    });

    const createData = await createRes.json();

    if (!createRes.ok && createRes.status !== 409) {
      console.error("Loops create error:", JSON.stringify(createData));
      return res.status(500).json({ error: "Failed to join waitlist. Please try again." });
    }

    // 2. Send confirmation email
    const emailRes = await fetch("https://app.loops.so/api/v1/transactional", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOOPS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transactionalId: LOOPS_TRANSACTIONAL_ID,
        email,
        dataVariables: {
          referralLink,
          unsubscribeUrl: "",
        },
      }),
    });

    if (!emailRes.ok) {
      const emailErr = await emailRes.json();
      console.error("Confirmation email error:", JSON.stringify(emailErr));
    }

    // 3. If referred, look up referrer by userId (their referral code) and update badge
    if (referredBy) {
      await updateReferrer(referredBy);
    }

    return res.status(200).json({
      success: true,
      referralLink,
      alreadySignedUp: createRes.status === 409,
    });

  } catch (err) {
    console.error("Waitlist error:", err.message);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}

async function updateReferrer(referralCode) {
  try {
    // Find referrer by userId = their referralCode — fast and reliable
    const findRes = await fetch(
      `https://app.loops.so/api/v1/contacts/find?userId=${referralCode}`,
      { headers: { Authorization: `Bearer ${LOOPS_API_KEY}` } }
    );

    if (!findRes.ok) return;
    const contacts = await findRes.json();
    if (!contacts.length) return;

    const referrer = contacts[0];
    const previousCount = referrer.referralCount || 0;
    const newCount = previousCount + 1;
    const previousBadge = referrer.badge || "";
    const newBadge = getBadge(newCount) || previousBadge;
    const badgeUnlocked = newBadge !== previousBadge;

    await fetch("https://app.loops.so/api/v1/contacts/update", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${LOOPS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: referrer.email,
        referralCount: newCount,
        badge: newBadge,
      }),
    });

    if (badgeUnlocked && LOOPS_BADGE_TRANSACTIONAL_ID) {
      await fetch("https://app.loops.so/api/v1/transactional", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOOPS_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transactionalId: LOOPS_BADGE_TRANSACTIONAL_ID,
          email: referrer.email,
          dataVariables: {
            badge: newBadge,
            referralCount: newCount,
            unsubscribeUrl: "",
          },
        }),
      });
    }
  } catch (err) {
    console.error("updateReferrer error:", err.message);
  }
}
