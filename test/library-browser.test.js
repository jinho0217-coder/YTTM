const test = require("node:test");
const assert = require("node:assert/strict");
const { submitPreparedReservation } = require("../scripts/library-browser");

test("submission reads the receipt and dismisses the dialog before the click completes", async () => {
  let showDialog;
  let finishClick;
  const dialog = new Promise(resolve => { showDialog = resolve; });
  const clickDone = new Promise(resolve => { finishClick = resolve; });
  const page = {
    waitForEvent: () => dialog,
    getByRole: (role, options) => {
      assert.equal(role, "button");
      assert.equal(options.name, "예약하기");
      return { click: () => {
        showDialog({ type: () => "alert", message: () => "신청이 정상적으로 완료되었습니다.", dismiss: finishClick });
        return clickDone;
      } };
    },
  };
  assert.deepEqual(await submitPreparedReservation(page), { status: "submitted" });
});
