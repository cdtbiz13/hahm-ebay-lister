/**
 * Tracker bridge for the lister app's Source / Intake screens.
 *
 * Paste this whole file into the tracker: Extensions → Apps Script.
 * Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 * Put the /exec URL in Vercel as TRACKER_SCRIPT_URL and the SECRET below as
 * TRACKER_SCRIPT_SECRET.
 *
 * It only does what the app asks: read a range, write ranges, list tabs, and
 * add the hidden "App Intake" tab. Every request must carry the SECRET.
 */

const SECRET = 'PASTE_SECRET_HERE';

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!SECRET || SECRET === 'PASTE_SECRET_HERE' || body.secret !== SECRET) {
      return reply_({ ok: false, error: 'unauthorized' });
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    switch (body.op) {
      case 'get':
        return reply_({ ok: true, result: trim_(ss.getRange(body.range).getDisplayValues()) });

      case 'update': {
        const lock = LockService.getDocumentLock();
        lock.waitLock(20000);
        try {
          (body.data || []).forEach(function (d) {
            ss.getRange(d.range).setValues(d.values);
          });
          SpreadsheetApp.flush();
        } finally {
          lock.releaseLock();
        }
        return reply_({ ok: true, result: true });
      }

      case 'tabs':
        return reply_({
          ok: true,
          result: ss.getSheets().map(function (s) {
            return { title: s.getName(), sheetId: s.getSheetId() };
          }),
        });

      case 'addHiddenTab': {
        if (!ss.getSheetByName(body.title)) {
          const sheet = ss.insertSheet(body.title);
          sheet.getRange(1, 1, 1, body.header.length).setValues([body.header]);
          sheet.hideSheet();
        }
        return reply_({ ok: true, result: true });
      }

      default:
        return reply_({ ok: false, error: 'unknown op' });
    }
  } catch (err) {
    return reply_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// Match the Sheets API: drop empty trailing cells and rows.
function trim_(rows) {
  const out = rows.map(function (r) {
    let end = r.length;
    while (end > 0 && r[end - 1] === '') end--;
    return r.slice(0, end);
  });
  let last = out.length;
  while (last > 0 && out[last - 1].length === 0) last--;
  return out.slice(0, last);
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
