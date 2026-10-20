// Tracks run progress by reading wizard.py's stdout. Every item (a call, a
// recording/transcription, a conference, a video room) weighs the same.
//
// gen/core.py rolls each category's count only when that category starts, so
// the total isn't known up front. Until a category has announced its count
// (`[plan] calls=23`) the tracker estimates it from the profile's spec, and
// reports `estimated: true`.
//
// Parsed formats (printed by gen/core.py, keep them in sync):
//   [plan] calls=N | rec_trans=N | conf=N | video_rooms=N | video_recordings=N
//   [call i/n]  [rec/trans i/n]  [conf i/n]  [video_room i/n]  [video_rec i/n]

const PROD_MAX_PER_CATEGORY = 30; // mirrors gen/safety.py, estimate only

const CATEGORY_BY_PREFIX = { call: 'calls', 'rec/trans': 'rec_trans', conf: 'conf', video_room: 'video_rooms', video_rec: 'video_recordings' };
const PLAN_RE = /^\[plan\] (calls|rec_trans|conf|video_rooms|video_recordings)=(\d+)/;
const ITEM_RE = /^\[(call|rec\/trans|conf|video_room|video_rec) (\d+)\/(\d+)\]/;

// Expected item count for a count spec ("0", "12", "10-30"): midpoint of a range.
const expectedFromSpec = (spec, cap = Infinity) => {
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(spec).trim());
  if (!m) return 0;
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : Number(m[2]);
  return Math.min(Math.round((lo + hi) / 2), cap);
};

const expectedCounts = (profile) => {
  const cap = profile.tier === 'prod' && !profile.noProdCap ? PROD_MAX_PER_CATEGORY : Infinity;
  const on = (c) => profile.categories.includes(c);
  return {
    calls: on('calls') ? expectedFromSpec(profile.calls, cap) : 0,
    rec_trans: on('recordings_transcriptions') ? expectedFromSpec(profile.recordingsTranscriptions, cap) : 0,
    conf: on('conferences') ? expectedFromSpec(profile.conferences, cap) : 0,
    video_rooms: profile.videoEnabled && profile.tier !== 'prod' ? expectedFromSpec(profile.videoRooms) : 0,
    video_recordings: profile.videoEnabled && profile.videoRecordingsEnabled && profile.tier !== 'prod' ? expectedFromSpec(profile.videoParticipants) : 0,
  };
};

const createProgress = (expected) => {
  const planned = {};
  const done = { calls: 0, rec_trans: 0, conf: 0, video_rooms: 0, video_recordings: 0 };
  let buffer = '';

  const feedLine = (line) => {
    let m = PLAN_RE.exec(line);
    if (m) {
      planned[m[1]] = Number(m[2]);
      return;
    }
    m = ITEM_RE.exec(line);
    if (m) {
      const cat = CATEGORY_BY_PREFIX[m[1]];
      planned[cat] = Number(m[3]);
      done[cat] += 1;
    }
  };

  // chunks can split a line in two, so only complete lines are parsed
  const feed = (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(feedLine);
  };

  const snapshot = () => {
    const cats = Object.keys(done);
    return {
      done: cats.reduce((n, c) => n + done[c], 0),
      total: cats.reduce((n, c) => n + (planned[c] ?? expected[c] ?? 0), 0),
      estimated: cats.some((c) => planned[c] === undefined && (expected[c] ?? 0) > 0),
    };
  };

  // per-category done/total (same estimate rule as snapshot), for live display
  const breakdown = () => Object.fromEntries(Object.keys(done).map((c) => [c, { done: done[c], total: planned[c] ?? expected[c] ?? 0 }]));

  return { feed, snapshot, breakdown };
};

// Whole-number percent. Never shows 100 while the run is still going: after the
// last item the wizard still polls Twilio for final statuses.
const percent = ({ done, total }, finished = false) => {
  if (finished) return 100;
  if (!total) return 0;
  return Math.min(99, Math.floor((done / total) * 100));
};

module.exports = { createProgress, expectedCounts, expectedFromSpec, percent };
