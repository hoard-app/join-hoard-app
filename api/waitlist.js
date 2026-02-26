// api/waitlist.js — Vercel Serverless Function
// Handles: signup, referral tracking, badge milestones, Loops contact creation + transactional email

const LOOPS_API_KEY = process.env.LOOPS_API_KEY;
const LOOPS_TRANSACTIONAL_ID = process.env.LOOPS_TRANSACTIONAL_ID; // Confirmation email sent on signup
const LOOPS_BADGE_TRANSACTIONAL_ID = process.env.LOOPS_BADGE_TRANSACTIONAL_ID; // Badge unlock email
const BASE_URL = process.env.BASE_URL; // e.g. https://hoardapp.co

// Badge milestones
// Add more tiers here if needed in the future
const BADGE_MILESTONES = {
  1: "bronze",
  2: "silver",
  3: "gold",
};

function getBadge(referralCount) {
  // Return the highest badge earned, or null if none yet
  const earned = Object.entries(BADGE_MILESTONES)
    .filter(([threshold]) => referralCount >= Number(threshold))
    .map(([, badge]) => badge);
  return earned.length ? earned[earned.length - 1] : null;
}

// Generate a short, unique referral code from email
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
  // CORS headers — adjust origin to your domain in production
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
    // 1. Create contact in Loops with custom properties
    const createRes = await fetch("https://app.loops.so/api/v1/contacts/create", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOOPS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        source: "waitlist",
        subscribed: true,
        // Custom properties — must be created in Loops dashboard first (see README)
        referralCode,
        referralLink,
        referredBy: referredBy || "",
        referralCount: 0,
        badge: "",
      }),
    });

    const createData = await createRes.json();

    // Handle duplicate signup gracefully
    if (!createRes.ok && createRes.status !== 409) {
      console.error("Loops create error:", createData);
      return res.status(500).json({ error: "Failed to join waitlist. Please try again." });
    }

    // 2. Send confirmation email with referral link
    await fetch("https://app.loops.so/api/v1/transactional", {
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
          referralCode,
        },
      }),
    });

    // 3. If this signup came via a referral, update the referrer's count + badge
    if (referredBy) {
      await updateReferrer(referredBy);
    }

    return res.status(200).json({
      success: true,
      referralCode,
      referralLink,
      alreadySignedUp: createRes.status === 409,
    });

  } catch (err) {
    console.error("Waitlist error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}

// Helper: find referrer by referralCode, increment their count, assign badge if milestone hit
async function updateReferrer(referralCode) {
  try {
    const searchRes = await fetch(
      `https://app.loops.so/api/v1/contacts/find?referralCode=${referralCode}`,
      { headers: { Authorization: `Bearer ${LOOPS_API_KEY}` } }
    );

    if (!searchRes.ok) return;
    const contacts = await searchRes.json();
    if (!contacts.length) return;

    const referrer = contacts[0];
    const previousCount = referrer.referralCount || 0;
    const newCount = previousCount + 1;
    const previousBadge = referrer.badge || "";
    const newBadge = getBadge(newCount) || previousBadge;
    const badgeUnlocked = newBadge !== previousBadge;

    // Update referrer contact with new count and badge
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

    // Send badge unlock email only when a new milestone is crossed
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
            badge: newBadge,           // "bronze" | "silver" | "gold"
            referralCount: newCount,
          },
        }),
      });
    }
  } catch (err) {
    console.error("Failed to update referrer:", err);
    // Non-fatal — don't block the signup response
  }
}
