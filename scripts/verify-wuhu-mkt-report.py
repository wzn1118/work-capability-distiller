import json
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(r"C:\Users\10847\Documents\MKT大师")
OUT_DIR = ROOT / "output" / "wuhu-mkt-audience-analysis-20260814"
REPORT_PATH = OUT_DIR / "三国杀WUHU联盟卡宝粉丝与受众MKT全量洞察报告.html"
EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
RESULT_PATH = OUT_DIR / "browser-verification.json"


def inspect_view(page, name, width, height):
    console_errors = []
    page_errors = []
    page.on(
        "console",
        lambda message: console_errors.append(message.text)
        if message.type == "error"
        else None,
    )
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.set_viewport_size({"width": width, "height": height})
    page.goto(REPORT_PATH.as_uri(), wait_until="load")
    page.wait_for_timeout(400)

    measurements = page.evaluate(
        """
        () => {
          const root = document.documentElement;
          const sections = [...document.querySelectorAll('main section')].map((el) => {
            const rect = el.getBoundingClientRect();
            return {id: el.id, width: Math.round(rect.width), height: Math.round(rect.height)};
          });
          const svgs = [...document.querySelectorAll('svg')].map((el) => {
            const rect = el.getBoundingClientRect();
            return {width: Math.round(rect.width), height: Math.round(rect.height)};
          });
          const returnCells = [...document.querySelectorAll('.return-cell')].map((el) => ({
            clientHeight: el.clientHeight,
            scrollHeight: el.scrollHeight,
            clientWidth: el.clientWidth,
            scrollWidth: el.scrollWidth,
          }));
          const accidentalOverflow = [...document.querySelectorAll('body *')]
            .filter((el) => {
              const style = getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) return false;
              if (el.closest('.table-wrap, .quad-panel, .chart-scroll')) return false;
              return el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2;
            })
            .slice(0, 12)
            .map((el) => ({
              tag: el.tagName,
              className: String(el.className || '').slice(0, 100),
              clientWidth: el.clientWidth,
              scrollWidth: el.scrollWidth,
            }));
          return {
            title: document.title,
            viewportWidth: innerWidth,
            documentWidth: root.scrollWidth,
            documentHeight: root.scrollHeight,
            bodyHorizontalOverflow: root.scrollWidth > innerWidth + 1,
            sectionCount: sections.length,
            sections,
            h2Count: document.querySelectorAll('h2').length,
            tableCount: document.querySelectorAll('table').length,
            svgCount: svgs.length,
            svgs,
            returnCellCount: returnCells.length,
            returnCells,
            calculatorInputCount: document.querySelectorAll('.calculator input').length,
            accidentalOverflow,
          };
        }
        """
    )

    default_calculator = {
        key: page.locator(f"#{key}").inner_text()
        for key in ("deposits", "paid", "revenue", "net")
    }
    page.locator("#conv").fill("30")
    page.wait_for_timeout(100)
    updated_calculator = {
        key: page.locator(f"#{key}").inner_text()
        for key in ("deposits", "paid", "revenue", "net")
    }

    screenshot_path = OUT_DIR / f"verification-{name}.png"
    page.screenshot(path=str(screenshot_path), full_page=True)

    expected_default = {
        "deposits": "31",
        "paid": "28",
        "revenue": "¥2,772",
        "net": "-¥3,684",
    }
    expected_updated = {
        "deposits": "46",
        "paid": "41",
        "revenue": "¥4,059",
        "net": "-¥3,073",
    }
    checks = {
        "no_body_horizontal_overflow": not measurements["bodyHorizontalOverflow"],
        "no_unexpected_element_overflow": not measurements["accidentalOverflow"],
        "all_sections_rendered": measurements["sectionCount"] == 9,
        "all_charts_nonblank": measurements["svgCount"] == 2
        and all(item["width"] > 200 and item["height"] > 120 for item in measurements["svgs"]),
        "monthly_return_cards_complete": measurements["returnCellCount"] == 8
        and all(
            item["scrollHeight"] <= item["clientHeight"] + 2
            and item["scrollWidth"] <= item["clientWidth"] + 2
            for item in measurements["returnCells"]
        ),
        "calculator_inputs_present": measurements["calculatorInputCount"] == 6,
        "calculator_default_correct": default_calculator == expected_default,
        "calculator_update_correct": updated_calculator == expected_updated,
        "no_console_errors": not console_errors,
        "no_page_errors": not page_errors,
        "screenshot_created": screenshot_path.exists() and screenshot_path.stat().st_size > 10_000,
    }
    return {
        "viewport": {"name": name, "width": width, "height": height},
        "measurements": measurements,
        "calculator": {"default": default_calculator, "after_30_percent": updated_calculator},
        "consoleErrors": console_errors,
        "pageErrors": page_errors,
        "screenshot": str(screenshot_path),
        "checks": checks,
        "passed": all(checks.values()),
    }


def main():
    if not REPORT_PATH.is_file():
        raise FileNotFoundError(REPORT_PATH)
    if not EDGE_PATH.is_file():
        raise FileNotFoundError(EDGE_PATH)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=str(EDGE_PATH),
            headless=True,
            args=["--allow-file-access-from-files"],
        )
        try:
            desktop = inspect_view(browser.new_page(), "desktop", 1440, 1100)
            mobile = inspect_view(browser.new_page(), "mobile", 390, 844)
            compact = inspect_view(browser.new_page(), "compact", 320, 800)
            result = {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "report": str(REPORT_PATH),
                "browser": browser.version,
                "viewports": [desktop, mobile, compact],
                "passed": desktop["passed"] and mobile["passed"] and compact["passed"],
            }
        finally:
            browser.close()

    RESULT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"result": str(RESULT_PATH), "passed": result["passed"]}, ensure_ascii=False))
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
