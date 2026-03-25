const axios = require("axios");

const BASE_URL = "https://data.mixpanel.com/api/2.0";

function getAuthHeader() {
  const secret = process.env.MIXPANEL_API_SECRET;
  const encoded = Buffer.from(`${secret}`).toString("base64");
  return `Basic ${encoded}`;
}

function pid() {
  return process.env.MIXPANEL_PROJECT_ID;
}

// ─────────────────────────────────────────
// 1. 이벤트 집계 (segmentation)
//    전환율·이벤트 횟수·추이 등 일반 통계
// ─────────────────────────────────────────
async function getAggregatedStats({
  event,
  from_date,
  to_date,
  type = "general",
  unit = "day",
  on,
}) {
  const params = { project_id: pid(), event, from_date, to_date, type, unit };
  if (on) params.on = on;
  const res = await axios.get(`${BASE_URL}/segmentation`, {
    headers: { Authorization: getAuthHeader() },
    params,
  });
  return res.data;
}

// ─────────────────────────────────────────
// 2. 원시 이벤트 로그 export
//    세션 분석·체류시간·날짜 비교·필터링 등
//    로우 데이터가 필요한 모든 케이스
// ─────────────────────────────────────────
async function exportRawEvents({
  from_date,
  to_date,
  event,
  where,
  limit = 5000,
}) {
  const params = { project_id: pid(), from_date, to_date };
  if (event) params.event = JSON.stringify([event]);
  if (where) params.where = where;

  const res = await axios.get(`${BASE_URL}/export`, {
    headers: { Authorization: getAuthHeader() },
    params,
    responseType: "text",
  });

  // export API → 줄바꿈 구분 NDJSON
  const lines = (res.data || "").trim().split("\n").filter(Boolean);
  const events = lines.slice(0, limit).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

  // Claude에게 넘길 때 토큰 절약을 위해 필드 정리
  const slim = events.map((e) => ({
    distinct_id: e.distinct_id,
    event: e.event,
    time: e.properties?.$time || e.properties?.time,
    path: e.properties?.page_path || e.properties?.["$current_url"],
    ...Object.fromEntries(
      Object.entries(e.properties || {})
        .filter(([k]) => !k.startsWith("$"))
        .slice(0, 10),
    ),
  }));

  return { total: lines.length, returned: events.length, events: slim };
}

// ─────────────────────────────────────────
// 3. 퍼널 분석
// ─────────────────────────────────────────
async function getFunnel({ funnel_id, from_date, to_date, unit = "day" }) {
  const res = await axios.get(`${BASE_URL}/funnels`, {
    headers: { Authorization: getAuthHeader() },
    params: { project_id: pid(), funnel_id, from_date, to_date, unit },
  });
  return res.data;
}

// ─────────────────────────────────────────
// 4. 리텐션 분석
// ─────────────────────────────────────────
async function getRetention({
  born_event,
  return_event,
  from_date,
  to_date,
  unit = "day",
  interval_count = 7,
}) {
  const res = await axios.get(`${BASE_URL}/retention`, {
    headers: { Authorization: getAuthHeader() },
    params: {
      project_id: pid(),
      from_date,
      to_date,
      born_event,
      event: return_event,
      interval: 1,
      interval_count,
      unit,
      retention_type: "birth",
    },
  });
  return res.data;
}

// ─────────────────────────────────────────
// 5. TOP 이벤트 목록
// ─────────────────────────────────────────
async function getTopEvents({
  from_date,
  to_date,
  limit = 20,
  type = "general",
}) {
  const res = await axios.get(`${BASE_URL}/events/top`, {
    headers: { Authorization: getAuthHeader() },
    params: { project_id: pid(), from_date, to_date, limit, type },
  });
  return res.data;
}

// ─────────────────────────────────────────
// 6. 속성별 세그멘테이션
// ─────────────────────────────────────────
async function getSegmentByProperty({
  event,
  property,
  from_date,
  to_date,
  unit = "day",
  type = "general",
}) {
  return getAggregatedStats({
    event,
    from_date,
    to_date,
    type,
    unit,
    on: `properties["${property}"]`,
  });
}

// ─────────────────────────────────────────
// 도구 실행 라우터
// Claude Tool Use에서 toolName + toolInput으로 호출
// ─────────────────────────────────────────
async function executeTool(toolName, toolInput) {
  const map = {
    get_aggregated_stats: getAggregatedStats,
    export_raw_events: exportRawEvents,
    get_funnel: getFunnel,
    get_retention: getRetention,
    get_top_events: getTopEvents,
    get_segment_by_property: getSegmentByProperty,
  };

  const fn = map[toolName];
  if (!fn) throw new Error(`알 수 없는 도구: ${toolName}`);
  return await fn(toolInput);
}

module.exports = { executeTool };
