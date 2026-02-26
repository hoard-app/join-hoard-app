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

function generateReferralCode(email) {
  let hash = 0;
  const str = email.toLowerCase().trim();
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36).toUpperCase().slice(0, 7);
}

async function findReferrerEmail(referralCode) {
  try {
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const url = cursor
        ? `https://app.loops.so/api/v1/contacts?perPage=10&cursor=${cursor}`
        : `https://app.loops.so/api/v1/contacts?perPage=10`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${LOOPS_API_KEY}` },
      });

      if (!res.ok) break;
      const data = await res.json();
      const contacts = data.data || data;
      const match = contacts.find((c) => c.referralCode === referralCode);
      if (match) return match.email;
      if (!data.pagination?.nextCursor) break;
      cursor = data.pagination.nextCursor;
    }
  } catch (err) {
    console.error("findReferrerEmail error:", err);
  }
  return null;
}

async function updateReferrer(referrerEmail) {
  try {
    const contactRes = await fetch(
      `https://app.loops.so/api/v1/contacts?email=${encodeURIComponent(referrerEmail)}`,
      { headers: { Authorization: `Bearer ${LOOPS_API_KEY}` } }
    );

    if (!contactRes.ok) return;
    const contacts = await contactRes.json();
    const referrer = Array.isArray(contacts) ? contacts[0] : (contacts.data || [])[0];
    if (!referrer) return;

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
        email: referrerEmail,
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
          email: referrerEmail,
          dataVariables: {
            badge: newBadge,
            referralCount: newCount,
          },
        }),
      });
    }
  } catch (err) {
    console.error("updateReferrer error:", err);
  }
}

module.exports = async function handler(req, res) {
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
        referralCode,
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
          referralCode,
        },
      }),
    });

    const emailData = await emailRes.json();
    if (!emailRes.ok) {
      console.error("Confirmation email error:", JSON.stringify(emailData));
    } else {
      console.log("Confirmation email sent:", JSON.stringify(emailData));
    }

    // 3. If referred, find referrer and update badge
    if (referredBy) {
      const referrerEmail = await findReferrerEmail(referredBy);
      if (referrerEmail) {
        await updateReferrer(referrerEmail);
      } else {
        console.warn("Referrer not found for code:", referredBy);
      }
    }

    return res.status(200).json({
      success: true,
      referralCode,
      referralLink,
      alreadySignedUp: createRes.status === 409,
    });

  } catch (err) {
    console.error("Waitlist error:", err.message);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
