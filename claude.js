const Anthropic = require("@anthropic-ai/sdk");
const { executeTool } = require("./mixpanel");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────
// Claude에게 제공할 Mixpanel 도구 목록
// 이 목록만 늘리면 대응 가능한 질문 유형이 자동으로 확장됨
// ─────────────────────────────────────────
const MIXPANEL_TOOLS = [
  {
    name: "get_aggregated_stats",
    description: `이벤트 집계 데이터를 조회합니다.
용도: 전환율, 이벤트 발생 횟수, 일별/주별 추이, 유니크 유저 수 등 일반적인 통계.
날짜 범위와 이벤트명을 지정하면 unit(day/week/month) 단위로 집계된 수치를 반환합니다.
type=unique 로 설정하면 유니크 유저 기준으로 집계합니다.`,
    input_schema: {
      type: "object",
      properties: {
        event: {
          type: "string",
          description: '이벤트명 (예: "Purchase Complete", "Product View")',
        },
        from_date: { type: "string", description: "시작일 YYYY-MM-DD" },
        to_date: { type: "string", description: "종료일 YYYY-MM-DD" },
        type: {
          type: "string",
          enum: ["general", "unique"],
          description: "general=전체 발생수, unique=유니크 유저 수",
        },
        unit: {
          type: "string",
          enum: ["day", "week", "month"],
          description: "집계 단위",
        },
        on: {
          type: "string",
          description: '속성별 분류 시 사용 (예: properties["page_type"])',
        },
      },
      required: ["event", "from_date", "to_date"],
    },
  },
  {
    name: "export_raw_events",
    description: `원시 이벤트 로그를 가져옵니다.
용도: 세션 분석, 체류시간·이탈률 계산, 특정 날짜 비교, 특정 페이지/상품 필터링,
     퍼널 직접 계산, 사용자 행동 패턴 분석 등 집계 API로 불가능한 모든 케이스.
where 파라미터로 특정 상품·페이지 조건을 SQL처럼 필터링할 수 있습니다.
반환 데이터: distinct_id, event명, 타임스탬프, 페이지 경로 등 이벤트 속성 포함.`,
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "시작일 YYYY-MM-DD" },
        to_date: { type: "string", description: "종료일 YYYY-MM-DD" },
        event: {
          type: "string",
          description: "특정 이벤트만 필터 (없으면 전체)",
        },
        where: {
          type: "string",
          description:
            'JQL 필터 (예: properties["page_path"] == "/product/123")',
        },
        limit: { type: "number", description: "최대 반환 건수 (기본 5000)" },
      },
      required: ["from_date", "to_date"],
    },
  },
  {
    name: "get_funnel",
    description: `퍼널 분석 데이터를 조회합니다.
용도: 상품조회 → 장바구니 → 결제 시작 → 구매완료 단계별 전환율, 어느 단계에서 이탈이 많은지.
Mixpanel에 미리 정의된 funnel_id가 필요합니다.`,
    input_schema: {
      type: "object",
      properties: {
        funnel_id: { type: "string", description: "Mixpanel Funnel ID" },
        from_date: { type: "string", description: "시작일 YYYY-MM-DD" },
        to_date: { type: "string", description: "종료일 YYYY-MM-DD" },
        unit: { type: "string", enum: ["day", "week", "month"] },
      },
      required: ["funnel_id", "from_date", "to_date"],
    },
  },
  {
    name: "get_retention",
    description: `리텐션(재방문) 분석 데이터를 조회합니다.
용도: 신규 유저가 일정 기간 후 얼마나 재방문하는지, 코호트별 재방문율.
born_event(최초 진입 이벤트)와 return_event(재방문 이벤트)를 지정합니다.`,
    input_schema: {
      type: "object",
      properties: {
        born_event: {
          type: "string",
          description: '최초 진입 이벤트 (예: "Page View")',
        },
        return_event: {
          type: "string",
          description: '재방문 이벤트 (예: "Purchase Complete")',
        },
        from_date: { type: "string", description: "시작일 YYYY-MM-DD" },
        to_date: { type: "string", description: "종료일 YYYY-MM-DD" },
        unit: { type: "string", enum: ["day", "week", "month"] },
        interval_count: {
          type: "number",
          description: "분석할 기간 수 (기본 7)",
        },
      },
      required: ["born_event", "return_event", "from_date", "to_date"],
    },
  },
  {
    name: "get_top_events",
    description: `가장 많이 발생한 이벤트 목록을 조회합니다.
용도: 어떤 이벤트가 가장 많이 발생했는지 전체 현황 파악, 이상 이벤트 감지.`,
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "시작일 YYYY-MM-DD" },
        to_date: { type: "string", description: "종료일 YYYY-MM-DD" },
        limit: { type: "number", description: "반환할 이벤트 수 (기본 20)" },
        type: { type: "string", enum: ["general", "unique"] },
      },
      required: ["from_date", "to_date"],
    },
  },
  {
    name: "get_segment_by_property",
    description: `특정 속성값별로 이벤트를 분류해 조회합니다.
용도: 기기별(모바일/PC), 유입경로별, 페이지별, 상품 카테고리별 이벤트 분포 비교.`,
    input_schema: {
      type: "object",
      properties: {
        event: { type: "string", description: "이벤트명" },
        property: {
          type: "string",
          description: '분류 기준 속성명 (예: "page_type", "referrer")',
        },
        from_date: { type: "string", description: "시작일 YYYY-MM-DD" },
        to_date: { type: "string", description: "종료일 YYYY-MM-DD" },
        type: { type: "string", enum: ["general", "unique"] },
      },
      required: ["event", "property", "from_date", "to_date"],
    },
  },
];

// ─────────────────────────────────────────
// 시스템 프롬프트
// ─────────────────────────────────────────
function buildSystemPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `당신은 카페24 자사몰의 Mixpanel 데이터 분석 전문가입니다.
오늘 날짜: ${today}

[역할]
슬랙에서 직원들이 자연어로 질문하면, 주어진 Mixpanel 도구를 사용해 데이터를 직접 조회하고 분석합니다.

[자사몰 이벤트 구조]
- Page View: 페이지 조회 (page_path, page_type 속성 포함)
- Product View: 상품 상세 조회 (product_name, product_id, price, category 포함)
- Add to Cart: 장바구니 담기
- Begin Checkout: 결제 시작
- Purchase Complete: 구매 완료 (revenue, order_id, item_count 포함)
- Search: 검색 (search_keyword 포함)
- Buy Now Click: 바로구매 버튼 클릭

[분석 가이드]
- 날짜 비교가 필요하면 export_raw_events를 두 번 호출해 각 기간 데이터를 비교
- 세션 이탈률: 같은 distinct_id의 연속 이벤트 타임스탬프 차이로 계산
- 3초 이탈: Product View 이후 다음 이벤트까지 gap이 3초 미만이면 이탈로 판단
- 전환율: (Purchase Complete 수 / Product View 수) × 100
- 복잡한 분석은 여러 도구를 순차적으로 호출해도 됨

[답변 형식 — 슬랙 mrkdwn]
*📊 분석 결과*
핵심 수치 bullet 정리

*💡 인사이트*
데이터의 의미 2~3줄

*🎯 추천 액션*
구체적인 개선 방안 1~2개

[주의]
- 항상 한국어로 답변
- 수치는 단위 명확히 (회, 명, %, 원)
- 데이터 오류 시 솔직하게 알리고 가능한 대안 제시
- 슬랙 mrkdwn 형식 사용 (*굵게*, _기울임_)`;
}

// ─────────────────────────────────────────
// 핵심: Agentic Tool Use 루프
// Claude가 스스로 도구를 선택·실행하고
// 결과를 보고 추가 도구 호출 여부를 결정
// ─────────────────────────────────────────
async function analyzeWithToolUse(question) {
  const messages = [{ role: "user", content: question }];
  const MAX_ITERATIONS = 6; // 무한루프 방지

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: buildSystemPrompt(),
      tools: MIXPANEL_TOOLS,
      messages,
    });

    // ── 종료 조건: 최종 텍스트 답변 완성 ──
    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock?.text || "분석 결과를 생성하지 못했습니다.";
    }

    // ── 도구 호출 요청이 있으면 실행 ──
    if (response.stop_reason === "tool_use") {
      // assistant 메시지 히스토리에 추가
      messages.push({ role: "assistant", content: response.content });

      // 병렬 도구 실행 (Claude가 여러 도구를 동시에 요청할 수 있음)
      const toolResults = await Promise.all(
        response.content
          .filter((b) => b.type === "tool_use")
          .map(async (toolCall) => {
            console.log(
              `[도구 호출] ${toolCall.name}`,
              JSON.stringify(toolCall.input),
            );
            let result;
            try {
              result = await executeTool(toolCall.name, toolCall.input);
            } catch (err) {
              result = { error: err.message };
            }
            console.log(
              `[도구 결과] ${toolCall.name} → ${JSON.stringify(result).slice(0, 200)}...`,
            );
            return {
              type: "tool_result",
              tool_use_id: toolCall.id,
              content: JSON.stringify(result),
            };
          }),
      );

      // 도구 결과를 user 메시지로 추가 → 다음 루프에서 Claude가 결과를 보고 판단
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // 예상치 못한 stop_reason
    break;
  }

  return "분석 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
}

module.exports = { analyzeWithToolUse };
