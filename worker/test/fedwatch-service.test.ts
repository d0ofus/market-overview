import { describe, expect, it } from "vitest";
import {
  parseFedWatchIframeSrc,
  parseFedWatchRedirectLocation,
  parseFedWatchToolHtml,
} from "../src/fedwatch-service";

describe("fedwatch service helpers", () => {
  it("extracts the embedded CME QuikStrike iframe URL", () => {
    const html = `
      <html>
        <body>
          <iframe src="https://cmegroup-tools.quikstrike.net/User/QuikStrikeTools.aspx?viewitemid=IntegratedFedWatchTool&amp;userId=lwolf"></iframe>
        </body>
      </html>
    `;

    expect(parseFedWatchIframeSrc(html)).toBe(
      "https://cmegroup-tools.quikstrike.net/User/QuikStrikeTools.aspx?viewitemid=IntegratedFedWatchTool&userId=lwolf",
    );
  });

  it("reads a sessionized redirect URL from response headers", () => {
    const headers = [
      "HTTP/1.1 302 Found",
      "location: https://cmegroup-tools.quikstrike.net/User/QuikStrikeTools.aspx?viewitemid=IntegratedFedWatchTool&userId=lwolf&insid=123&qsid=abc",
    ].join("\n");

    expect(parseFedWatchRedirectLocation(headers)).toContain("qsid=abc");
  });

  it("parses meeting metadata and target-rate probabilities from FedWatch html", () => {
    const html = `
      <div>Current target rate is 350-375</div>
      <div class="fedwatch-meeting">
        <table>
          <tr>
            <th>MEETING DATE</th>
            <th>CONTRACT</th>
            <th>EXPIRES</th>
            <th>MID PRICE</th>
            <th>PRIOR VOLUME</th>
            <th>PRIOR OI</th>
          </tr>
          <tr>
            <td>29 Apr 2026</td>
            <td>ZQJ6</td>
            <td>30 Apr 2026</td>
            <td>96.3525</td>
            <td>123,569</td>
            <td>471,704</td>
          </tr>
        </table>
        <table>
          <tr>
            <th>TARGET RATE (BPS)</th>
            <th>NOW*</th>
            <th>1 DAY</th>
            <th>1 WEEK</th>
            <th>1 MONTH</th>
          </tr>
          <tr>
            <td>300-325</td>
            <td>0.0%</td>
            <td>0.0%</td>
            <td>0.0%</td>
            <td>0.8%</td>
          </tr>
          <tr>
            <td>325-350</td>
            <td>0.0%</td>
            <td>0.0%</td>
            <td>3.9%</td>
            <td>18.4%</td>
          </tr>
          <tr>
            <td>350-375 (Current)</td>
            <td>92.8%</td>
            <td>87.6%</td>
            <td>96.0%</td>
            <td>80.8%</td>
          </tr>
          <tr>
            <td>375-400</td>
            <td>7.2%</td>
            <td>12.4%</td>
            <td>0.0%</td>
            <td>0.0%</td>
          </tr>
        </table>
      </div>
    `;

    const parsed = parseFedWatchToolHtml(html, "2026-03-24T00:00:00.000Z");

    expect(parsed?.currentTargetRange).toBe("350-375");
    expect(parsed?.meetings).toHaveLength(1);
    expect(parsed?.meetings[0]?.meetingDate).toBe("2026-04-29");
    expect(parsed?.meetings[0]?.probabilities.map((row) => row.targetRange)).toEqual([
      "300-325",
      "325-350",
      "350-375",
      "375-400",
    ]);
    expect(parsed?.meetings[0]?.expectedMidpointBps).toBeCloseTo(364, 0);
    expect(parsed?.meetings[0]?.hikeProbability).toBeCloseTo(7.2, 5);
    expect(parsed?.meetings[0]?.noChangeProbability).toBeCloseTo(92.8, 5);
  });

  it("returns null when meeting tables are missing", () => {
    expect(parseFedWatchToolHtml("<html><body>empty</body></html>")).toBeNull();
  });
});
