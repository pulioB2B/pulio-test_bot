require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { analyzeWithToolUse } = require("./claude");

// ─────────────────────────────────────────
// Slack App 초기화
// ─────────────────────────────────────────
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// Render 헬스체크 (무료플랜 슬립 방지)
receiver.router.get("/", (req, res) => {
  res
    .status(200)
    .json({ status: "ok", message: "Mixpanel Slack Bot running 🚀" });
});

// ─────────────────────────────────────────
// @봇 멘션 처리
// ─────────────────────────────────────────
app.event("app_mention", async ({ event, client }) => {
  // 멘션 태그 제거
  const question = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();

  if (!question) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: "안녕하세요! 자사몰 데이터에 대해 질문해주세요 😊\n예시: `@분석봇 3월 12일 전후 7일 구매 전환율 비교해줘`",
    });
    return;
  }

  // 로딩 메시지
  const loading = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.ts,
    text: "🔍 Mixpanel 데이터 분석 중... 복잡한 질문은 30초 내외 소요될 수 있어요!",
  });

  try {
    // Tool Use 기반 분석 (Claude가 알아서 필요한 API 호출)
    const result = await analyzeWithToolUse(question);

    await client.chat.update({
      channel: loading.channel,
      ts: loading.ts,
      text: result,
    });
  } catch (err) {
    console.error("[오류]", err);
    await client.chat.update({
      channel: loading.channel,
      ts: loading.ts,
      text: `❌ 분석 중 오류가 발생했습니다.\n\`${err.message}\`\n\n잠시 후 다시 시도해주세요.`,
    });
  }
});

// ─────────────────────────────────────────
// 서버 시작
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  await app.start(PORT);
  console.log(`✅ Mixpanel Slack Bot 실행 중 (포트: ${PORT})`);
})();
