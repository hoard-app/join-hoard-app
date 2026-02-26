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

// Encode referrer email into URL-safe base64
function encodeRef(email) {
  return Buffer.from(email.toLowerCase().trim()).toString("base64url");
}

// Decode ref param back to email
function decodeRef(ref) {
  try {
    return Buffer.from(ref, "base64url").toString("utf8");
  } catch {
    return null;
  }
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

  // Referral link encodes the user's own email so we can look them up directly
  const refCode = encodeRef(email);
  const referralLink = `${BASE_URL}?ref=${refCode}`;

  try {
    // 1. Create contact in Loops
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

    const emailData = await emailRes.json();
    if (!emailRes.ok) {
      console.error("Confirmation email error:", JSON.stringify(emailData));
    }

    // 3. If referred, decode referrer email directly and update them
    if (referredBy) {
      const referrerEmail = decodeRef(referredBy);
      if (referrerEmail && referrerEmail.includes("@")) {
        await updateReferrer(referrerEmail);
      } else {
        console.warn("Could not decode referrer from:", referredBy);
      }
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
};

async function updateReferrer(referrerEmail) {
  try {
    // Find referrer directly by email
    const findRes = await fetch(
      `https://app.loops.so/api/v1/contacts/find?email=${encodeURIComponent(referrerEmail)}`,
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

    // Update referrer count and badge
    await fetch("https://app.loops.so/api/v1/contacts/update", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${LOOPS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: referrerEmail,
        referralCount: newCount,
        badge: newBadge,
      }),
    });

    // Send badge email if milestone crossed
    if (badgeUnlocked && LOOPS_BADGE_TRANSACTIONAL_ID) {
      await fetch("https://app.loops.so/api/v1/transactional", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOOPS_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transactionalId: LOOPS_BADGE_TRANSACTIONAL_ID,
          email: referrerEmail,
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
