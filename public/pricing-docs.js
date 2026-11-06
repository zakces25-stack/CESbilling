/*
 * pricing-docs.js - signed contracts on the pricing desk (4 Nov 2026).
 *
 *   var D = CrmDocs.create({ sb, esc, who, loadPdfJs });
 *   D.cell(k, i)                 the "Signed contract" cell of a contract row (k from crm_contracts_v)
 *   D.wire(el, rows, onChange)   makes those cells work: view, download, upload
 *   D.renderLibrary(el, cb)      the Signed contracts page: coverage, the bulk matcher, recent files
 *
 * Files live in the PRIVATE bucket crm-documents. crm_documents holds one row per FILE with the
 * deals it covers (uc_tender_ids) and its meters (mpans): UtilityClick holds a multi-site
 * contract as one deal per meter (3,291 live deals for 3,328 live meter contracts, 4 Nov 2026),
 * so a 20-site contract is one file attached to twenty deals, never twenty copies.
 *
 * The bulk matcher reads the meter numbers out of each file (the file name, and the text of a
 * PDF), keeps only the ones that are real meters on the desk, and proposes the deals they belong
 * to. Nothing is stored until a person has looked at the proposals and pressed Upload.
 *
 * ASCII only. Special characters are HTML entities, never literal.
 */
(function (root) {
  'use strict';

  var VERSION = '2026-11-06.1';
  var BUCKET = 'crm-documents';
  var MAX_BYTES = 50 * 1024 * 1024;
  var TYPES = {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', tif: 'image/tiff',
    tiff: 'image/tiff', heic: 'image/heic', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    msg: 'application/vnd.ms-outlook', eml: 'message/rfc822',
  };
  var PRIMES = [3, 5, 7, 13, 17, 19, 23, 29, 31, 37, 41, 43];

  // ------------------------------------------------------------------ pure helpers (tested)
  /** The MPAN core check digit: 13 digits, the last one checks the first twelve. */
  function mpanOk(s) {
    var d = String(s == null ? '' : s).replace(/\s/g, '');
    if (!/^\d{13}$/.test(d)) return false;
    var t = 0;
    for (var i = 0; i < 12; i++) t += Number(d[i]) * PRIMES[i];
    return (t % 11) % 10 === Number(d[12]);
  }

  /**
   * Meter numbers in a piece of text. An MPAN core is written "1900012345678", "19 0001 2345 678"
   * or inside the 21 digits of a full MPAN; an MPRN is 6 to 10 digits. Generous on purpose: the
   * candidates are checked against the meters on the desk before anything is proposed, so a
   * phone number that happens to pass the check digit goes nowhere.
   */
  function candidatesIn(text) {
    var mp = {}, mr = {};
    var runs = String(text || '').match(/\d[\d \-]*\d|\d/g) || [];
    runs.forEach(function (run) {
      var toks = run.split(/[ \-]+/).filter(Boolean);
      for (var a = 0; a < toks.length; a++) {
        var joined = '';
        for (var b = a; b < toks.length && b < a + 6; b++) {
          joined += toks[b];
          if (joined.length === 13 && mpanOk(joined)) mp[joined] = 1;
          if (joined.length === 21 && mpanOk(joined.slice(8))) mp[joined.slice(8)] = 1;
          if (joined.length > 21) break;
        }
        if (/^\d{6,10}$/.test(toks[a])) mr[toks[a]] = 1;
      }
    });
    return { mpans: Object.keys(mp), mprns: Object.keys(mr) };
  }

  function extOf(name) { var m = /\.([a-z0-9]{2,5})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
  function typeOf(file) { return file.type || TYPES[extOf(file.name)] || 'application/octet-stream'; }
  /** A storage key: letters, digits, dot, dash and underscore only, the end of the name kept. */
  function safeName(name) {
    var s = String(name || 'document').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_');
    return s.length > 100 ? s.slice(-100) : s;
  }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function uk(iso) { if (!iso) return ''; var s = String(iso).slice(0, 10).split('-'); return s.length === 3 ? s[2] + '/' + s[1] + '/' + s[0] : String(iso); }
  function n0(v) { return v == null || v === '' ? '' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 }); }
  function kb(b) { b = Number(b) || 0; return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  function chunk(a, n) { var out = []; for (var i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }

  // The contract cell is the FIRST column of every list (6 Nov 2026: CES had to scroll to the
  // bottom of a 100-row table and slide right to reach View). One button says what there is:
  // View when the signed contract is on file, Upload when it is not; download and "add another
  // file" are small icons beside View.
  var ICON_DL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>';
  var ICON_ADD = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

  var STYLES = [
    '.dc-cell{white-space:nowrap;width:1%}',
    '.dc-btns{display:flex;gap:4px;align-items:center}',
    '.dc-cell .act{margin:0}',
    '.dc-cell .act.sm{padding:5px 11px}',
    '.dc-cell .dc-ico{display:inline-grid;place-items:center;padding:4px 5px;line-height:0}',
    '.dc-cell .dc-up{min-width:66px}',
    '.dc-list{margin-top:6px;font-size:11.5px;line-height:1.7;white-space:normal;min-width:200px}',
    '.dc-list a{cursor:pointer}',
    '.dc-pick{background:var(--panel-2);border:1px solid var(--line-2);border-radius:10px;padding:12px 14px;margin:6px 0}',
    '.dc-pick label{display:flex;gap:8px;align-items:flex-start;text-transform:none;letter-spacing:0;font-size:12.5px;font-weight:500;color:var(--text);margin:4px 0}',
    '.dc-pick label input{width:auto;height:auto;margin-top:2px}',
    '.dc-cov{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}',
    '.dc-cov .t{background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:12px 14px}',
    '.dc-cov .k{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}',
    '.dc-cov .v{font-size:20px;font-weight:800;margin-top:4px;font-variant-numeric:tabular-nums}',
    '.dc-cov .s{font-size:11.5px;color:var(--text-2)}',
    '.dc-bar{height:6px;border-radius:99px;background:var(--line);margin-top:8px;overflow:hidden}',
    '.dc-bar i{display:block;height:100%;background:var(--cyan)}',
    '.dc-drop{border:2px dashed var(--line-2);border-radius:12px;padding:26px 18px;text-align:center;cursor:pointer}',
    '.dc-drop.over{border-color:var(--cyan-dim);background:var(--cyan-glow)}',
    '.dc-rev td{vertical-align:top}',
    '.dc-rev select{min-width:260px;max-width:440px}',
    '.dc-ok{color:var(--ok);font-weight:700}.dc-bad{color:var(--fail);font-weight:700}.dc-warn{color:var(--warn);font-weight:700}',
  ].join('\n');
  function injectStyles(doc) {
    if (!doc || doc.getElementById('dcStyles')) return;
    var s = doc.createElement('style'); s.id = 'dcStyles'; s.textContent = STYLES; doc.head.appendChild(s);
  }

  function create(o) {
    var sb = o.sb, esc = o.esc, who = o.who || function () { return ''; };
    var doc = root.document;
    injectStyles(doc);

    function q(builder, what) {
      return Promise.resolve(builder).then(function (r) {
        if (r.error) throw new Error(what + ': ' + r.error.message);
        return r;
      });
    }

    // -------------------------------------------------------------- open, download, store
    /** A signed link to a stored file, 10 minutes. With a name it downloads instead of opening. */
    function signedUrl(d, download) {
      var st = sb.storage.from(BUCKET);
      var opts = download ? { download: d.file_name } : undefined;
      return Promise.resolve(st.createSignedUrl(d.storage_path, 600, opts)).then(function (r) {
        if (r.error || !r.data) throw new Error('Could not open ' + d.file_name + ': ' + ((r.error && r.error.message) || 'no link'));
        return r.data.signedUrl || r.data.signedURL;
      });
    }
    /**
     * View opens the file in a new tab. The tab is opened FIRST, inside the click, and pointed
     * at the file once the signed link is back: a window opened after an await is a popup, and
     * browsers block it.
     */
    function view(d) {
      var w = root.open ? root.open('', '_blank') : null;
      return signedUrl(d, false).then(function (u) {
        if (w) { try { w.opener = null; } catch (_) { /* cross-window */ } w.location.href = u; }
        else root.location.assign(u);
        return u;
      }).catch(function (e) { if (w) w.close(); throw e; });
    }
    function download(d) {
      return signedUrl(d, true).then(function (u) {
        var a = doc.createElement('a'); a.href = u; a.rel = 'noopener'; a.download = d.file_name;
        doc.body.appendChild(a); a.click(); a.remove();
        return u;
      });
    }
    function docsForDeal(tenderId) {
      return q(sb.from('crm_documents').select('*').contains('uc_tender_ids', [tenderId]).is('removed_at', null)
        .eq('kind', 'signed_contract').order('uploaded_at', { ascending: false }), 'signed contracts').then(function (r) { return r.data || []; });
    }

    /**
     * Store one file against one or more deals of ONE customer. A file already on the desk (same
     * SHA-256) is not stored twice: if it covers other deals it is refused with a pointer to it.
     */
    function store(file, links, how) {
      if (!file) return Promise.reject(new Error('No file.'));
      if (file.size > MAX_BYTES) return Promise.reject(new Error(file.name + ' is ' + kb(file.size) + '; the limit is 50 MB.'));
      if (!TYPES[extOf(file.name)] && !/^(application\/pdf|image\/)/.test(file.type || '')) {
        return Promise.reject(new Error(file.name + ': only PDF, Word, image or saved email files.'));
      }
      if (!links || !links.uc_customer_id || !(links.uc_tender_ids || []).length) return Promise.reject(new Error('Pick the contract it belongs to first.'));
      var shaP = (root.crypto && root.crypto.subtle && file.arrayBuffer)
        ? file.arrayBuffer().then(function (b) { return root.crypto.subtle.digest('SHA-256', b); }).then(hex) : Promise.resolve(null);
      return shaP.then(function (sha) {
        var dupP = sha ? q(sb.from('crm_documents').select('id,file_name,uc_customer_id,uc_tender_ids').eq('sha256', sha).is('removed_at', null).limit(5), 'duplicate check')
          .then(function (r) { return r.data || []; }) : Promise.resolve([]);
        return dupP.then(function (dups) {
          if (dups.length) {
            var d0 = dups[0];
            var covers = links.uc_tender_ids.every(function (t) { return (d0.uc_tender_ids || []).indexOf(t) >= 0; });
            if (covers) { var e = new Error('Already on file as ' + d0.file_name + '.'); e.duplicate = true; throw e; }
            // Same file, more deals: widen the existing row instead of storing it again.
            var merged = (d0.uc_tender_ids || []).slice();
            links.uc_tender_ids.forEach(function (t) { if (merged.indexOf(t) < 0) merged.push(t); });
            return q(sb.from('crm_documents').update({ uc_tender_ids: merged }).eq('id', d0.id).select('id'), 'attach to more contracts')
              .then(function (r) {
                if (!r.data || !r.data.length) throw new Error('Nothing was saved (permissions?).');
                return { id: d0.id, widened: true, file_name: d0.file_name };
              });
          }
          var path = links.uc_customer_id + '/' + links.uc_tender_ids[0] + '/' + Date.now() + '_' + safeName(file.name);
          return Promise.resolve(sb.storage.from(BUCKET).upload(path, file, { contentType: typeOf(file), upsert: false })).then(function (u) {
            if (u.error) throw new Error('Upload of ' + file.name + ' failed: ' + u.error.message);
            return q(sb.from('crm_documents').insert({
              uc_customer_id: links.uc_customer_id, uc_tender_ids: links.uc_tender_ids, mpans: links.mpans || [],
              kind: 'signed_contract', file_name: file.name, storage_path: path, sha256: sha, size_bytes: file.size,
              content_type: typeOf(file), source: how && how.bulk ? 'bulk' : 'upload', matched_by: (how && how.matchedBy) || null,
              uploaded_by_name: who() || 'pricing desk',
            }).select('id'), 'record the file').then(function (r) {
              return { id: r.data && r.data[0] && r.data[0].id, path: path, file_name: file.name };
            }).catch(function (e) {
              // The row failed: do not leave an orphan file behind in the bucket.
              sb.storage.from(BUCKET).remove([path]);
              throw e;
            });
          });
        });
      });
    }
    function removeDoc(d) {
      return q(sb.from('crm_documents').update({ removed_at: new Date().toISOString(), removed_by_name: who() || 'pricing desk' })
        .eq('id', d.id).select('id'), 'remove').then(function (r) {
        if (!r.data || !r.data.length) throw new Error('Nothing was removed (permissions?).');
        return Promise.resolve(sb.storage.from(BUCKET).remove([d.storage_path]));
      });
    }

    /** Contracts signed together with this one: same customer, supplier, start date and group. */
    function siblings(k) {
      var b = sb.from('crm_contracts_v').select('id,uc_tender_id,mpan,site_name,supplier,meter_start,meter_end,lifecycle,service_group')
        .eq('uc_customer_id', k.uc_customer_id).eq('supplier', k.supplier || '');
      b = k.meter_start ? b.eq('meter_start', k.meter_start) : b.is('meter_start', null);
      return q(b.order('mpan').range(0, 499), 'contracts signed together').then(function (r) {
        return (r.data || []).filter(function (x) { return x.service_group === k.service_group; });
      });
    }

    // -------------------------------------------------------------- the cell on a contract row
    function cell(k, i) {
      var n = Number(k.signed_docs) || 0;
      if (!k || !k.uc_tender_id) return '<td class="dc-cell"><span class="crm-small">no contract</span></td>';
      if (n) {
        return '<td class="dc-cell" data-doc-cell="' + i + '"><div class="dc-btns">' +
          '<button class="act sm" data-doc-view="' + i + '" title="Open the signed contract in a new tab">View' + (n > 1 ? ' (' + n + ')' : '') + '</button>' +
          '<button class="act ghost sm dc-ico" data-doc-dl="' + i + '" title="Download the signed contract" aria-label="Download">' + ICON_DL + '</button>' +
          '<button class="act ghost sm dc-ico" data-doc-up="' + i + '" title="Add another file to this contract" aria-label="Add another file">' + ICON_ADD + '</button>' +
          '</div></td>';
      }
      return '<td class="dc-cell" data-doc-cell="' + i + '"><button class="act ghost sm dc-up" data-doc-up="' + i + '" ' +
        'title="No signed contract on file: upload it">Upload</button></td>';
    }

    function wire(el, rows, onChange) {
      var errBox = function (td, e) {
        var d = doc.createElement('div'); d.className = 'note bad'; d.style.marginTop = '6px';
        d.textContent = e.message || String(e); td.appendChild(d);
      };
      [].forEach.call(el.querySelectorAll('[data-doc-view],[data-doc-dl]'), function (b) {
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var dl = b.hasAttribute('data-doc-dl');
          var k = rows[Number(b.getAttribute(dl ? 'data-doc-dl' : 'data-doc-view'))];
          var td = b.closest('td');
          // Opened synchronously when there is one file, so the new tab is not a blocked popup;
          // the list is fetched first only when the count says there are several.
          if (!dl && Number(k.signed_docs) === 1) {
            var w = root.open ? root.open('', '_blank') : null;
            docsForDeal(k.uc_tender_id).then(function (ds) {
              if (!ds.length) { if (w) w.close(); throw new Error('The file is no longer on file.'); }
              return signedUrl(ds[0], false).then(function (u) { if (w) w.location.href = u; else root.location.assign(u); });
            }).catch(function (e) { if (w) w.close(); errBox(td, e); });
            return;
          }
          docsForDeal(k.uc_tender_id).then(function (ds) {
            if (ds.length === 1 && dl) return download(ds[0]);
            var box = td.querySelector('.dc-list') || td.appendChild(doc.createElement('div'));
            box.className = 'dc-list';
            box.innerHTML = ds.map(function (d, j) {
              return '<div>' + esc(d.file_name) + ' <span class="crm-small">' + uk(d.uploaded_at) + '</span> ' +
                '<a data-v="' + j + '">view</a> &middot; <a data-d="' + j + '">download</a></div>';
            }).join('') || '<div class="crm-small">none</div>';
            [].forEach.call(box.querySelectorAll('a[data-v]'), function (a) { a.addEventListener('click', function () { view(ds[Number(a.getAttribute('data-v'))]).catch(function (e) { errBox(td, e); }); }); });
            [].forEach.call(box.querySelectorAll('a[data-d]'), function (a) { a.addEventListener('click', function () { download(ds[Number(a.getAttribute('data-d'))]).catch(function (e) { errBox(td, e); }); }); });
          }).catch(function (e) { errBox(td, e); });
        });
      });
      [].forEach.call(el.querySelectorAll('[data-doc-up]'), function (b) {
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var k = rows[Number(b.getAttribute('data-doc-up'))];
          var td = b.closest('td'), tr = b.closest('tr');
          var input = doc.createElement('input');
          input.type = 'file'; input.accept = '.pdf,.doc,.docx,.jpg,.jpeg,.png,.tif,.tiff,.heic,.msg,.eml';
          input.className = 'hide';
          td.appendChild(input);
          input.addEventListener('change', function () {
            var file = input.files && input.files[0];
            input.remove();
            if (!file) return;
            pickAndStore(tr, k, file, onChange);
          });
          input.click();
        });
      });
    }

    /** After a file is chosen: tick the contracts it covers (the ones signed together), then store. */
    function pickAndStore(tr, k, file, onChange) {
      var cols = tr.children.length;
      var row = doc.createElement('tr');
      row.innerHTML = '<td colspan="' + cols + '"><div class="dc-pick">Reading the contracts signed with this one&hellip;</div></td>';
      tr.parentNode.insertBefore(row, tr.nextSibling);
      var box = row.querySelector('.dc-pick');
      siblings(k).then(function (sib) {
        if (!sib.some(function (x) { return x.uc_tender_id === k.uc_tender_id; })) sib.unshift(k);
        box.innerHTML = '<b>' + esc(file.name) + '</b> <span class="crm-small">' + kb(file.size) + '</span>' +
          '<div class="crm-small" style="margin:4px 0 6px">Which contracts does it cover? These were signed with ' + esc(k.supplier || 'the same supplier') +
          ' for the same start date; untick any it does not cover.</div>' +
          sib.map(function (x, j) {
            var me = x.uc_tender_id === k.uc_tender_id;
            return '<label><input type="checkbox" data-sib="' + j + '" checked' + (me ? ' disabled' : '') + '> <span><span class="mono">' + esc(x.mpan) + '</span> ' +
              esc(x.site_name || '') + ' <span class="crm-small">' + uk(x.meter_start) + ' to ' + uk(x.meter_end) + (me ? ', this one' : '') + '</span></span></label>';
          }).join('') +
          '<div style="margin-top:8px;display:flex;gap:8px;align-items:center"><button class="act sm" data-go>Upload</button>' +
          '<button class="act ghost sm" data-no>Cancel</button><span class="crm-small" data-msg></span></div>';
        box.querySelector('[data-no]').addEventListener('click', function () { row.remove(); });
        box.querySelector('[data-go]').addEventListener('click', function () {
          var btn = this, msg = box.querySelector('[data-msg]');
          var picked = sib.filter(function (x, j) { var c = box.querySelector('[data-sib="' + j + '"]'); return c && c.checked; });
          btn.disabled = true; msg.textContent = 'Uploading...';
          store(file, { uc_customer_id: k.uc_customer_id, uc_tender_ids: picked.map(function (x) { return x.uc_tender_id; }),
                        mpans: picked.map(function (x) { return x.mpan; }) }, { matchedBy: 'picked on the contract' })
            .then(function (res) {
              msg.innerHTML = '<span class="dc-ok">' + (res.widened ? 'Already on file; now attached to these contracts too.' : 'Stored.') + '</span>';
              if (onChange) setTimeout(onChange, 300);
            })
            .catch(function (e) { btn.disabled = false; msg.innerHTML = '<span class="dc-bad">' + esc(e.message) + '</span>'; });
        });
      }).catch(function (e) { box.innerHTML = '<span class="dc-bad">' + esc(e.message) + '</span>'; });
    }

    // -------------------------------------------------------------- reading files for the matcher
    function pdfText(file) {
      if (!o.loadPdfJs) return Promise.resolve('');
      return o.loadPdfJs().then(function (lib) {
        return file.arrayBuffer().then(function (buf) {
          return lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
        }).then(function (pdf) {
          var pages = Math.min(pdf.numPages, 6), out = [], p = Promise.resolve();
          for (var i = 1; i <= pages; i++) {
            (function (n) {
              p = p.then(function () { return pdf.getPage(n); }).then(function (pg) { return pg.getTextContent(); })
                .then(function (tc) { out.push(tc.items.map(function (it) { return it.str; }).join(' ')); });
            })(i);
          }
          return p.then(function () { try { pdf.destroy(); } catch (_) { /* gone */ } return out.join('\n'); });
        });
      }).catch(function () { return ''; });       // a scan or a damaged PDF has no text: fall back to the name
    }

    /** Which of these numbers are meters on the desk. */
    function realMeters(nums) {
      if (!nums.length) return Promise.resolve([]);
      return Promise.all(chunk(nums, 150).map(function (part) {
        return q(sb.from('crm_meters_v').select('mpan,fuel,uc_customer_id,customer_name').in('mpan', part).limit(1000), 'meter lookup')
          .then(function (r) { return r.data || []; });
      })).then(function (parts) { return [].concat.apply([], parts); });
    }

    /** The deals those meters are on, grouped the way a contract is signed: customer, supplier, start. */
    function dealGroups(mpans, hint) {
      if (!mpans.length) return Promise.resolve([]);
      return Promise.all(chunk(mpans, 150).map(function (part) {
        return q(sb.from('crm_contracts_v').select('uc_tender_id,mpan,uc_customer_id,customer_name,supplier,product,meter_start,meter_end,lifecycle,term_state,service_group,signed_docs')
          .in('mpan', part).limit(1000), 'contracts for those meters').then(function (r) { return r.data || []; });
      })).then(function (parts) {
        var rows = [].concat.apply([], parts).filter(function (x) { return x.lifecycle !== 'lost' && x.lifecycle !== 'stale'; });
        var byKey = {};
        rows.forEach(function (x) {
          var key = x.uc_customer_id + '|' + (x.supplier || '') + '|' + (x.meter_start || '') + '|' + x.service_group;
          var g = byKey[key] || (byKey[key] = { key: key, uc_customer_id: x.uc_customer_id, customer_name: x.customer_name, supplier: x.supplier,
            meter_start: x.meter_start, meter_end: x.meter_end, term_state: x.term_state, service_group: x.service_group, deals: [], mpans: [], onFile: 0 });
          if (g.deals.indexOf(x.uc_tender_id) < 0) { g.deals.push(x.uc_tender_id); g.mpans.push(x.mpan); if (Number(x.signed_docs)) g.onFile++; }
          if (x.meter_end && (!g.meter_end || x.meter_end > g.meter_end)) g.meter_end = x.meter_end;
        });
        var svc = /\b(mop|dc|da|dcda|data collect|meter operat)/i.test(hint || '');
        var rank = { live: 0, upcoming: 1, undated: 2, ended: 3 };
        return Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) {
          return (b.mpans.length - a.mpans.length)
            || ((a.service_group === 'supply') === svc) - ((b.service_group === 'supply') === svc)
            || (rank[a.term_state] - rank[b.term_state])
            || String(b.meter_start || '').localeCompare(String(a.meter_start || ''));
        });
      });
    }

    function groupLabel(g) {
      return g.customer_name + ' - ' + (g.supplier || '?') + ' - ' + (g.meter_start ? 'from ' + uk(g.meter_start) : 'no start date') +
        ' - ' + g.deals.length + ' contract' + (g.deals.length === 1 ? '' : 's') +
        (g.service_group === 'meter_services' ? ' (meter services)' : g.service_group === 'other_services' ? ' (other services)' : '') +
        (g.term_state === 'ended' ? ' [ended]' : g.term_state === 'upcoming' ? ' [upcoming]' : '');
    }

    function analyse(file) {
      var it = { file: file, name: file.name, size: file.size, found: [], how: '', groups: [], pick: -1, state: 'reading', note: '' };
      var fromName = candidatesIn(file.name.replace(/\.[^.]+$/, '').replace(/_/g, ' '));
      var textP = /pdf$/i.test(extOf(file.name)) || file.type === 'application/pdf' ? pdfText(file) : Promise.resolve('');
      return textP.then(function (text) {
        var fromText = candidatesIn(text);
        it.hasText = text.replace(/\s/g, '').length > 40;
        var nums = {};
        fromName.mpans.concat(fromName.mprns, fromText.mpans, fromText.mprns).forEach(function (n) { nums[n] = 1; });
        return realMeters(Object.keys(nums).slice(0, 600)).then(function (meters) {
          var mp = {};
          meters.forEach(function (m) { mp[m.mpan] = 1; });
          it.found = Object.keys(mp);
          var inName = it.found.filter(function (n) { return fromName.mpans.indexOf(n) >= 0 || fromName.mprns.indexOf(n) >= 0; }).length;
          it.how = !it.found.length ? '' : inName === it.found.length ? 'file name' : inName ? 'file name and text' : 'PDF text';
          return dealGroups(it.found, file.name + ' ' + text.slice(0, 4000));
        }).then(function (groups) {
          it.groups = groups;
          it.pick = groups.length ? 0 : -1;
          it.state = !groups.length ? 'none' : (groups.length === 1 || groups[0].mpans.length > groups[1].mpans.length) && groups[0].term_state !== 'ended' ? 'sure' : 'check';
          return it;
        });
      }).catch(function (e) { it.state = 'error'; it.note = e.message; return it; });
    }

    // -------------------------------------------------------------- the Signed contracts page
    function renderLibrary(el, cb) {
      cb = cb || {};
      el.innerHTML = '<div class="note">Loading&hellip;</div>';
      return Promise.all([
        q(sb.rpc('crm_document_coverage'), 'coverage'),
        q(sb.from('crm_documents').select('*').is('removed_at', null).order('uploaded_at', { ascending: false }).limit(40), 'recent files'),
      ]).then(function (r) {
        var cov = r[0].data || [], recent = r[1].data || [];
        var get = function (g, t) { return cov.filter(function (x) { return x.service_group === g && x.term_state === t; })[0] || { contracts: 0, with_document: 0 }; };
        var tile = function (title, g, t) {
          var x = get(g, t), c = Number(x.contracts) || 0, w = Number(x.with_document) || 0, pct = c ? Math.round(w * 100 / c) : 0;
          return '<div class="t"><div class="k">' + title + '</div><div class="v">' + n0(w) + ' <span style="font-size:13px;color:var(--muted);font-weight:700">of ' + n0(c) + '</span></div>' +
            '<div class="s">' + pct + '% have the signed contract on file</div><div class="dc-bar"><i style="width:' + pct + '%"></i></div></div>';
        };
        el.innerHTML =
          '<div class="card"><h2>Signed contracts</h2><div class="sub">The signed contract for every live deal, on the desk instead of only in UtilityClick. ' +
          'Counted per meter contract: UtilityClick holds a multi-site contract as one deal per meter, so one PDF usually covers several.</div>' +
          '<div class="dc-cov">' + tile('Supply, live', 'supply', 'live') + tile('Supply, starting later', 'supply', 'upcoming') +
          tile('Meter services, live', 'meter_services', 'live') + tile('Other services, live', 'other_services', 'live') + '</div>' +
          (cb.openMissing ? '<div style="margin-top:12px"><button class="act ghost sm" id="dcMissing">Open No contract uploaded</button></div>' : '') +
          '</div>' +
          '<div class="card"><h2>Add signed contracts in bulk</h2><div class="sub">Drop up to 50 files at a time (PDF, Word, images or a saved email). Each one is read for ' +
          'meter numbers, in its name and in the text of a PDF, and matched to the contracts those meters are on. Nothing is stored until you have checked the matches ' +
          'and pressed Upload. A scanned PDF has no text to read: name it with an MPAN, or search for its contract in the row.</div>' +
          '<div class="dc-drop" id="dcDrop" tabindex="0" role="button"><b>Drop signed contracts here</b><div class="crm-small" style="margin-top:6px">or click to choose them</div>' +
          '<input type="file" id="dcFile" multiple class="hide" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.tif,.tiff,.heic,.msg,.eml"></div>' +
          '<div id="dcReview" style="margin-top:14px"></div>' +
          '<details style="margin-top:14px"><summary style="cursor:pointer;font-size:12.5px;font-weight:700;color:var(--cyan)">Getting the backlog in from UtilityClick</summary>' +
          '<div class="sub" style="margin-top:8px;max-width:none">' +
          '<b>Do not try to do everything.</b> Only live and upcoming deals matter: the ended ones are history and UtilityClick keeps them. ' +
          'Start with the deals ending soonest, because those are the renewals someone will open next.<br><br>' +
          '<b>Batch the downloads.</b> UtilityClick saves one contract at a time, so save 20 to 50 into one folder, then drop the whole folder here. ' +
          'The matching is the part this page does for you; the clicking in UC is the slow part.<br><br>' +
          '<b>Ask UtilityClick for a bulk export.</b> One email to UC support asking for every stored document with a list of which deal each belongs to ' +
          'would save days. With that list the matching is exact and needs no checking.<br><br>' +
          '<b>Keep it current from today.</b> When a new contract is signed, upload it on its contract row the same day; then the backlog only ever shrinks.' +
          '</div></details></div>' +
          '<div class="card"><h2>Recently added</h2>' + (recent.length ? '<div class="scroll"><table><thead><tr><th class="dc-cell">Contract</th><th>File</th><th>Customer</th>' +
            '<th class="num">Contracts</th><th>Added</th><th></th></tr></thead><tbody>' + recent.map(function (d, j) {
              return '<tr><td class="dc-cell"><div class="dc-btns"><button class="act sm" data-rv="' + j + '">View</button>' +
                '<button class="act ghost sm dc-ico" data-rd="' + j + '" title="Download" aria-label="Download">' + ICON_DL + '</button></div></td>' +
                '<td class="crm-wrap">' + esc(d.file_name) + '<div class="crm-small">' + kb(d.size_bytes) + (d.matched_by ? ', matched by ' + esc(d.matched_by) : '') + '</div></td>' +
                '<td class="crm-wrap"><a data-cust="' + esc(d.uc_customer_id) + '" style="cursor:pointer">' + esc(d.customer_name || 'open the customer') + '</a></td>' +
                '<td class="num">' + n0((d.uc_tender_ids || []).length) + '</td><td>' + uk(d.uploaded_at) + '<div class="crm-small">' + esc(d.uploaded_by_name || '') + '</div></td>' +
                '<td style="white-space:nowrap"><button class="act ghost sm" data-rx="' + j + '">Remove</button></td></tr>';
            }).join('') + '</tbody></table></div>' : '<div class="note">Nothing on file yet.</div>') + '<div id="dcRecentMsg"></div></div>';

        var custNames = {};
        var ids = recent.map(function (d) { return d.uc_customer_id; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
        if (ids.length) {
          q(sb.from('crm_customers_v').select('uc_customer_id,name').in('uc_customer_id', ids), 'customer names').then(function (rr) {
            (rr.data || []).forEach(function (c) { custNames[c.uc_customer_id] = c.name; });
            [].forEach.call(el.querySelectorAll('a[data-cust]'), function (a) { var nm = custNames[a.getAttribute('data-cust')]; if (nm) a.textContent = nm; });
          }).catch(function () { /* names are a nicety */ });
        }
        [].forEach.call(el.querySelectorAll('a[data-cust]'), function (a) {
          a.addEventListener('click', function () { if (cb.openCustomer) cb.openCustomer(a.getAttribute('data-cust')); });
        });
        var rmsg = el.querySelector('#dcRecentMsg');
        var say = function (e) { rmsg.innerHTML = '<div class="note bad" style="margin-top:10px">' + esc(e.message || String(e)) + '</div>'; };
        [].forEach.call(el.querySelectorAll('[data-rv]'), function (b) { b.addEventListener('click', function () { view(recent[Number(b.getAttribute('data-rv'))]).catch(say); }); });
        [].forEach.call(el.querySelectorAll('[data-rd]'), function (b) { b.addEventListener('click', function () { download(recent[Number(b.getAttribute('data-rd'))]).catch(say); }); });
        [].forEach.call(el.querySelectorAll('[data-rx]'), function (b) {
          b.addEventListener('click', function () {
            var d = recent[Number(b.getAttribute('data-rx'))];
            if (root.confirm && !root.confirm('Remove ' + d.file_name + ' from the desk? The file is deleted.')) return;
            b.disabled = true;
            removeDoc(d).then(function () { renderLibrary(el, cb); }).catch(function (e) { b.disabled = false; say(e); });
          });
        });
        if (cb.openMissing && el.querySelector('#dcMissing')) el.querySelector('#dcMissing').addEventListener('click', cb.openMissing);

        var drop = el.querySelector('#dcDrop'), input = el.querySelector('#dcFile');
        drop.addEventListener('click', function () { input.click(); });
        drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
        drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
        drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
        drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); review(el, e.dataTransfer.files, cb); });
        input.addEventListener('change', function () { review(el, input.files, cb); input.value = ''; });
      }).catch(function (e) { el.innerHTML = '<div class="note bad">' + esc(e.message) + '</div>'; });
    }

    var REVIEW = [];
    function review(el, fileList, cb) {
      var box = el.querySelector('#dcReview');
      var files = [].slice.call(fileList || []).slice(0, 50);
      if (!files.length) return;
      box.innerHTML = '<div class="note">Reading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '&hellip;</div>';
      var out = [], p = Promise.resolve();
      files.forEach(function (f, i) {
        p = p.then(function () {
          box.innerHTML = '<div class="note">Reading ' + (i + 1) + ' of ' + files.length + ': ' + esc(f.name) + '&hellip;</div>';
          return analyse(f).then(function (it) { out.push(it); });
        });
      });
      return p.then(function () {
        // Already on the desk? One query on the SHA-256 of every file.
        return Promise.all(out.map(function (it) {
          return it.file.arrayBuffer().then(function (b) { return root.crypto.subtle.digest('SHA-256', b); }).then(function (h) { it.sha = hex(h); });
        })).then(function () {
          var shas = out.map(function (it) { return it.sha; }).filter(Boolean);
          return shas.length ? q(sb.from('crm_documents').select('sha256,file_name').in('sha256', shas).is('removed_at', null), 'duplicate check').then(function (r) {
            (r.data || []).forEach(function (d) { out.forEach(function (it) { if (it.sha === d.sha256) { it.state = 'dup'; it.note = 'already on file as ' + d.file_name; } }); });
          }) : null;
        });
      }).then(function () { REVIEW = out; paintReview(el, cb); })
        .catch(function (e) { box.innerHTML = '<div class="note bad">' + esc(e.message) + '</div>'; });
    }

    function paintReview(el, cb) {
      var box = el.querySelector('#dcReview'), out = REVIEW;
      var sure = out.filter(function (it) { return it.state === 'sure'; }).length;
      var check = out.filter(function (it) { return it.state === 'check'; }).length;
      var none = out.filter(function (it) { return it.state === 'none' || it.state === 'error'; }).length;
      var dup = out.filter(function (it) { return it.state === 'dup'; }).length;
      box.innerHTML = '<div class="note" style="margin-bottom:10px">' + out.length + ' file' + (out.length === 1 ? '' : 's') + ': <b>' + sure + '</b> matched, <b>' + check +
        '</b> to check, <b>' + none + '</b> not matched' + (dup ? ', <b>' + dup + '</b> already on file' : '') + '.</div>' +
        '<div class="scroll"><table class="dc-rev"><thead><tr><th>File</th><th>Meters found</th><th>Contract it belongs to</th><th></th></tr></thead><tbody>' +
        out.map(function (it, i) {
          var opts = it.groups.map(function (g, j) { return '<option value="' + j + '"' + (j === it.pick ? ' selected' : '') + '>' + esc(groupLabel(g)) + '</option>'; }).join('');
          var state = it.state === 'sure' ? '<span class="dc-ok">matched</span>' : it.state === 'check' ? '<span class="dc-warn">check the match</span>'
            : it.state === 'dup' ? '<span class="crm-small">' + esc(it.note) + '</span>' : it.state === 'error' ? '<span class="dc-bad">' + esc(it.note || 'could not read it') + '</span>'
            : '<span class="dc-bad">no meter number found</span>' + (it.hasText === false ? '<div class="crm-small">no readable text (a scan?)</div>' : '');
          return '<tr data-i="' + i + '"><td class="crm-wrap">' + esc(it.name) + '<div class="crm-small">' + kb(it.size) + '</div></td>' +
            '<td>' + (it.found.length ? '<span class="mono">' + it.found.slice(0, 3).map(esc).join('<br>') + '</span>' + (it.found.length > 3 ? '<div class="crm-small">and ' + (it.found.length - 3) + ' more</div>' : '') +
              '<div class="crm-small">from the ' + esc(it.how) + '</div>' : '<span class="crm-small">none</span>') + '</td>' +
            '<td>' + (it.state === 'dup' ? '' : '<select data-pick="' + i + '"' + (it.groups.length ? '' : ' disabled') + '>' + opts +
              '<option value="-1"' + (it.pick < 0 ? ' selected' : '') + '>' + (it.groups.length ? 'Do not upload this one' : 'Nothing found yet') + '</option></select>' +
              '<div style="display:flex;gap:6px;margin-top:6px"><input data-find="' + i + '" placeholder="Search: MPAN or customer" style="height:30px;font-size:12px">' +
              '<button class="act ghost sm" data-findgo="' + i + '">Find</button></div>') + '</td>' +
            '<td>' + state + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="act" id="dcGo">Upload the matched files</button>' +
        '<span class="crm-small" id="dcProg"></span></div>';
      [].forEach.call(box.querySelectorAll('select[data-pick]'), function (s) {
        s.addEventListener('change', function () { var it = out[Number(s.getAttribute('data-pick'))]; it.pick = Number(s.value); if (it.pick >= 0 && it.state !== 'sure') it.state = 'check'; });
      });
      [].forEach.call(box.querySelectorAll('[data-findgo]'), function (b) {
        b.addEventListener('click', function () {
          var i = Number(b.getAttribute('data-findgo')), it = out[i];
          var term = String(box.querySelector('[data-find="' + i + '"]').value || '').trim();
          if (term.length < 3) return;
          b.disabled = true;
          var digits = term.replace(/\s/g, '');
          var qb = sb.from('crm_contracts_v').select('mpan').neq('lifecycle', 'lost');
          qb = /^\d{6,}$/.test(digits) ? qb.ilike('mpan', '%' + digits + '%') : qb.ilike('customer_name', '%' + term.replace(/[%_,()]/g, '%') + '%');
          q(qb.limit(500), 'search').then(function (r) {
            var mp = (r.data || []).map(function (x) { return x.mpan; }).filter(function (v, k, a) { return a.indexOf(v) === k; });
            return dealGroups(mp, it.name);
          }).then(function (groups) {
            it.groups = groups.slice(0, 40); it.pick = groups.length ? 0 : -1; it.how = 'search'; it.found = it.found.length ? it.found : [];
            it.state = groups.length ? 'check' : 'none';
            paintReview(el, cb);
          }).catch(function (e) { b.disabled = false; it.note = e.message; it.state = 'error'; paintReview(el, cb); });
        });
      });
      box.querySelector('#dcGo').addEventListener('click', function () {
        var btn = this, prog = box.querySelector('#dcProg');
        var todo = out.filter(function (it) { return it.pick >= 0 && it.state !== 'dup' && it.state !== 'done'; });
        if (!todo.length) { prog.textContent = 'Nothing picked to upload.'; return; }
        btn.disabled = true;
        var done = 0, failed = 0, p = Promise.resolve();
        todo.forEach(function (it) {
          p = p.then(function () {
            var g = it.groups[it.pick];
            prog.textContent = 'Uploading ' + (done + failed + 1) + ' of ' + todo.length + '...';
            return store(it.file, { uc_customer_id: g.uc_customer_id, uc_tender_ids: g.deals, mpans: g.mpans },
                         { bulk: true, matchedBy: it.how === 'search' ? 'picked from a search' : it.how ? it.how : 'picked' })
              .then(function () { it.state = 'done'; done++; })
              .catch(function (e) { it.state = 'error'; it.note = e.message; failed++; });
          });
        });
        p.then(function () {
          prog.innerHTML = '<b>' + done + ' stored</b>' + (failed ? ', <span class="dc-bad">' + failed + ' not stored</span> (see the rows)' : '') + '.';
          btn.disabled = false;
          [].forEach.call(box.querySelectorAll('tr[data-i]'), function (tr) {
            var it = out[Number(tr.getAttribute('data-i'))];
            if (it.state === 'done') tr.lastElementChild.innerHTML = '<span class="dc-ok">stored</span>';
            if (it.state === 'error') tr.lastElementChild.innerHTML = '<span class="dc-bad">' + esc(it.note) + '</span>';
          });
          if (cb && cb.onStored) cb.onStored(done);
        });
      });
    }

    return { VERSION: VERSION, BUCKET: BUCKET, cell: cell, wire: wire, renderLibrary: renderLibrary, store: store, view: view,
             download: download, docsForDeal: docsForDeal, analyse: analyse, _review: function () { return REVIEW; } };
  }

  root.CrmDocs = { VERSION: VERSION, create: create, mpanOk: mpanOk, candidatesIn: candidatesIn, safeName: safeName };
})(typeof window !== 'undefined' ? window : globalThis);
