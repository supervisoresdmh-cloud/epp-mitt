/**
 * ENTREGA DE EPP E INSUMOS – MITT SpA  (v5)
 * Web app para celular con dos módulos separados:
 *  - EPP: escaneo QR, firma del trabajador, PDF para auditoría, control de stock.
 *  - INSUMOS: entrega por trabajador y área, sin firma, control de stock y reporte de consumo mensual.
 *
 * Hojas EPP:      CATALOGO · ENTREGAS · MOVIMIENTOS
 * Hojas INSUMOS:  INS_CATALOGO · INS_ENTREGAS · INS_MOVIMIENTOS · INS_RESUMEN · INS_HISTORICO
 * Compartidas:    PERSONAL · AREAS
 *
 * v5.4: etiquetas: el PDF se descarga/comparte desde la app (sin pedir acceso a Drive).
 * v5.1: botón Ver PDF / Compartir: el PDF se descarga al celular desde la app (sin pedir acceso a Drive).
 * v5: la pantalla vive solo en GitHub Pages (doGet redirige) y acceso por usuario (RUT + PIN personal, hoja USUARIOS).
 * v4: alta de trabajadores desde la app (RUT escaneado de la cédula o digitado),
 *     asignar RUT a trabajadores que solo tenían nombre, y PDF PENDIENTE + regeneración
 *     si el PDF falla (la entrega nunca se registra dos veces).
 */

const CFG = {
  EMPRESA: 'MITT SpA',
  FAENA: 'Finning – División Ministro Hales (DMH), Calama',
  CODIGO_DOC: 'REG-EPP-MITT-SGI-01',   // <- reemplaza por el código de formato de tu SGI
  CARPETA: 'Entregas EPP MITT',        // carpeta de Drive donde quedan los PDF
  TZ: 'America/Santiago',
  PREFIJO_FOLIO: 'EPP-',
  PREFIJO_CODIGO: 'EPP',
  PREFIJO_FOLIO_INS: 'INS-',
  PREFIJO_CODIGO_INS: 'INS',
  PDF_PENDIENTE: 'PDF PENDIENTE',
  // URL de la app instalable (GitHub Pages). Quien entre a la URL antigua de Apps Script es enviado aquí.
  APP_URL: 'https://supervisoresdmh-cloud.github.io/epp-mitt/',
  // Acceso por usuario (hoja USUARIOS): RUT + PIN personal. Ningún PIN queda escrito en el código.
  SESION_DIAS: 7,          // días que dura la sesión en el celular
  MAX_FALLOS: 5,           // intentos fallidos antes de bloquear el RUT
  BLOQUEO_MIN: 15,         // minutos de bloqueo
  MARCA_PIN: '✔ PIN personal'   // lo que muestra la columna PIN cuando el usuario ya creó el suyo
};

const H = {
  // --- EPP ---
  CAT: { n: 'CATALOGO', h: ['Código', 'EPP', 'Talla', 'Unidad', 'Stock', 'Stock mínimo', 'Activo'] },
  ENT: { n: 'ENTREGAS', h: ['Folio', 'Fecha', 'Hora', 'RUT', 'Nombre', 'Cargo', 'Turno', 'Código', 'EPP', 'Talla', 'Cantidad', 'Motivo', 'Entregado por', 'Observación', 'PDF'] },
  MOV: { n: 'MOVIMIENTOS', h: ['Fecha', 'Hora', 'Tipo', 'Código', 'EPP', 'Talla', 'Cantidad', 'Stock resultante', 'Documento / Folio', 'Responsable', 'Observación'] },
  // --- Compartidas ---
  PER: { n: 'PERSONAL', h: ['RUT', 'Nombre', 'Cargo', 'Turno', 'Activo'] },
  AREA: { n: 'AREAS', h: ['Área', 'Activo'] },
  USR: { n: 'USUARIOS', h: ['RUT', 'Nombre', 'Rol', 'PIN', 'Activo', 'Último acceso'] },
  // --- Insumos ---
  ICAT: { n: 'INS_CATALOGO', h: ['Código', 'Insumo', 'Presentación', 'Unidad de entrega', 'Contenido por unidad', 'Medida', 'Stock', 'Stock mínimo', 'Activo'] },
  IENT: { n: 'INS_ENTREGAS', h: ['Folio', 'Fecha', 'Hora', 'Mes', 'Área', 'RUT', 'Nombre', 'Código', 'Insumo', 'Presentación', 'Unidad', 'Cantidad', 'Consumo total', 'Medida', 'Entregado por', 'Observación'] },
  IMOV: { n: 'INS_MOVIMIENTOS', h: ['Fecha', 'Hora', 'Tipo', 'Código', 'Insumo', 'Presentación', 'Cantidad', 'Stock resultante', 'Documento / Folio', 'Responsable', 'Observación'] }
};

/** Diferencias de estructura entre los catálogos de cada módulo (índices base 0). */
const MODS = {
  epp: { cat: 'CAT', mov: 'MOV', iStock: 4, iMin: 5, iAct: 6, pref: CFG.PREFIJO_CODIGO },
  ins: { cat: 'ICAT', mov: 'IMOV', iStock: 6, iMin: 7, iAct: 8, pref: CFG.PREFIJO_CODIGO_INS }
};
function mod_(m) { return MODS[m === 'ins' ? 'ins' : 'epp']; }

/* ---------------- API para la app instalada (GitHub Pages) ----------------
 * La app del celular corre fuera de Google (para poder usar la cámara en vivo)
 * y llama a estas funciones por internet. Salvo login, todas exigen una sesión válida (RUT + PIN personal).
 */
function api_() {
  return {
    getDatos: getDatos, registrarEntrega: registrarEntrega, registrarInsumos: registrarInsumos,
    consumoInsumos: consumoInsumos, ingresarStock: ingresarStock, ajustarStock: ajustarStock, etiquetasPdf: etiquetasPdf,
    crearTrabajador: crearTrabajador, asignarRut: asignarRut, cambiarPin: cambiarPin, cerrarSesion: cerrarSesion,
    obtenerPdf: obtenerPdf
  };
}

/** Usuario de la petición en curso (lo fija doPost). Vacío cuando se ejecuta desde el editor o el menú. */
let USR = null;

function doPost(e) {
  let out;
  try {
    USR = null;
    const req = JSON.parse(e.postData.contents);
    let fn;
    if (req.fn === 'login') {
      fn = login;
    } else {
      USR = sesion_(req.token);
      if (USR.cambio && req.fn !== 'cambiarPin' && req.fn !== 'cerrarSesion') throw new Error('CAMBIO_PIN');
      fn = api_()[req.fn];
    }
    if (typeof fn !== 'function') throw new Error('Función no permitida: ' + req.fn);
    out = { ok: true, data: fn.apply(null, req.args || []) };
  } catch (err) {
    out = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  if (e && e.parameter && e.parameter.ping) {
    return ContentService.createTextOutput(JSON.stringify({ ok: true, app: 'EPP MITT' })).setMimeType(ContentService.MimeType.JSON);
  }
  // La pantalla vive solo en GitHub Pages: la URL antigua de Apps Script redirige a la app instalable.
  const url = esc_(CFG.APP_URL);
  const html = '<!DOCTYPE html><html><head><base target="_top"></head>' +
    '<body style="font-family:system-ui,Arial,sans-serif;text-align:center;padding:40px 20px;background:#f2f4f7;color:#14202e">' +
    '<h2 style="color:#1f3a5f">La app de EPP cambió de dirección</h2>' +
    '<p>Ábrela con el botón y luego instálala en tu celular<br>(menú del navegador → <b>Agregar a pantalla de inicio</b>).</p>' +
    '<a href="' + url + '" target="_top" style="display:inline-block;background:#1e8e4e;color:#fff;padding:14px 24px;' +
    'border-radius:10px;text-decoration:none;font-weight:600;font-size:17px">Abrir app EPP</a>' +
    '<script>try { window.top.location.replace(' + JSON.stringify(CFG.APP_URL) + '); } catch (e) {}</script>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('EPP MITT')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------------- Usuarios y sesiones ----------------
 * Hoja USUARIOS: RUT · Nombre · Rol · PIN · Activo · Último acceso
 *  - El administrador escribe un PIN provisorio (ej. 1234) en la columna PIN.
 *  - Al ingresar con ese PIN, la app obliga a crear un PIN personal.
 *  - El PIN personal se guarda cifrado (hash con sal) en Propiedades del script; la celda queda "✔ PIN personal".
 *  - Para resetear a alguien: escribir de nuevo un PIN provisorio en su celda.
 *  - Para dar de baja: Activo = NO (su sesión deja de funcionar de inmediato).
 */
function usuario_(rut) {
  const sh = hoja_('USR');
  const v = sh.getDataRange().getValues();
  const n = normRut_(rut);
  for (let i = 1; i < v.length; i++) {
    if (n && normRut_(v[i][0]) === n) {
      return {
        fila: i + 1, rut: fmtRut_(v[i][0]), nombre: String(v[i][1]).trim(), rol: String(v[i][2]).trim(),
        pin: String(v[i][3]).trim(), activo: String(v[i][4]).trim().toUpperCase() !== 'NO'
      };
    }
  }
  return null;
}
function hashPin_(sal, rut, pin) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, sal + '|' + normRut_(rut) + '|' + String(pin));
  return d.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function pinOk_(u, pin) {
  pin = String(pin == null ? '' : pin).trim();
  if (!u || !pin) return false;
  if (u.pin === CFG.MARCA_PIN) {
    const h = PropertiesService.getScriptProperties().getProperty('PINH_' + normRut_(u.rut));
    if (!h) return false;
    const p = h.split(':');
    return hashPin_(p[0], u.rut, pin) === p[1];
  }
  return u.pin !== '' && pin === u.pin;   // PIN provisorio escrito en la hoja
}
function fallos_(rut, sumar) {
  const cache = CacheService.getScriptCache(), k = 'fallos_' + normRut_(rut);
  const n = Number(cache.get(k)) || 0;
  if (sumar) cache.put(k, String(n + 1), CFG.BLOQUEO_MIN * 60);
  return n + (sumar ? 1 : 0);
}
function sesion_(token) {
  if (!token) throw new Error('SESION');
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('SES_' + token);
  if (!raw) throw new Error('SESION');
  const s = JSON.parse(raw);
  if (s.exp < Date.now()) { props.deleteProperty('SES_' + token); throw new Error('SESION'); }
  const u = usuario_(s.rut);
  if (!u || !u.activo) { props.deleteProperty('SES_' + token); throw new Error('SESION'); }
  return { token: token, rut: u.rut, nombre: u.nombre, rol: u.rol, cambio: !!s.cambio };
}
function limpiarSesiones_() {
  const props = PropertiesService.getScriptProperties(), all = props.getProperties(), ahora = Date.now();
  Object.keys(all).forEach(k => {
    if (k.indexOf('SES_') !== 0) return;
    try { if (JSON.parse(all[k]).exp < ahora) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}
/** Nombre de quien opera: el usuario de la sesión; si se ejecuta desde el editor, lo que venga en el dato. */
function quien_(x) { return USR ? USR.nombre : String(x || '').trim(); }

function login(p) {
  const rut = fmtRut_(p && p.rut);
  if (!rutValido_(rut)) throw new Error('RUT inválido.');
  if (fallos_(rut) >= CFG.MAX_FALLOS) throw new Error('Demasiados intentos fallidos. Espera ' + CFG.BLOQUEO_MIN + ' minutos.');
  if (!ss_().getSheetByName(H.USR.n)) setup();
  const u = usuario_(rut);
  if (!u || !u.activo || !pinOk_(u, p.pin)) {
    const n = fallos_(rut, true);
    const quedan = CFG.MAX_FALLOS - n;
    throw new Error(quedan > 0 ? 'RUT o PIN incorrecto. Te quedan ' + quedan + ' intento(s).' :
      'Demasiados intentos fallidos. Espera ' + CFG.BLOQUEO_MIN + ' minutos.');
  }
  CacheService.getScriptCache().remove('fallos_' + normRut_(rut));
  const debe = u.pin !== CFG.MARCA_PIN;
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SES_' + token, JSON.stringify({ rut: u.rut, exp: Date.now() + CFG.SESION_DIAS * 864e5, cambio: debe }));
  hoja_('USR').getRange(u.fila, 6).setValue(new Date()).setNumberFormat('dd-mm-yyyy HH:mm');
  limpiarSesiones_();
  return { token: token, nombre: u.nombre, rol: u.rol, debeCambiar: debe };
}

function cambiarPin(p) {
  if (!USR) throw new Error('SESION');
  const u = usuario_(USR.rut);
  if (fallos_(USR.rut) >= CFG.MAX_FALLOS) throw new Error('Demasiados intentos fallidos. Espera ' + CFG.BLOQUEO_MIN + ' minutos.');
  if (!pinOk_(u, p && p.actual)) { fallos_(USR.rut, true); throw new Error('El PIN actual no es correcto.'); }
  const nuevo = String(p.nuevo || '').trim();
  if (!/^\d{4,8}$/.test(nuevo)) throw new Error('El nuevo PIN debe tener de 4 a 8 números.');
  if (nuevo === String(p.actual).trim()) throw new Error('El nuevo PIN debe ser distinto al actual.');
  if (/^(\d)\1+$/.test(nuevo) || '0123456789'.indexOf(nuevo) >= 0 || '9876543210'.indexOf(nuevo) >= 0) {
    throw new Error('PIN demasiado fácil (números repetidos o seguidos). Elige otro.');
  }
  const sal = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty('PINH_' + normRut_(u.rut), sal + ':' + hashPin_(sal, u.rut, nuevo));
  hoja_('USR').getRange(u.fila, 4).setValue(CFG.MARCA_PIN);
  const props = PropertiesService.getScriptProperties();
  const s = JSON.parse(props.getProperty('SES_' + USR.token));
  s.cambio = false;
  props.setProperty('SES_' + USR.token, JSON.stringify(s));
  CacheService.getScriptCache().remove('fallos_' + normRut_(u.rut));
  return { ok: true };
}

/** Devuelve el PDF de una entrega para verlo o compartirlo en el celular, sin pedir acceso a Drive.
 *  El original sigue guardado y privado en el Drive de la cuenta dueña del script. */
function obtenerPdf(folio) {
  folio = String(folio || '').trim();
  if (!folio) throw new Error('Falta el folio.');
  const v = hoja_('ENT').getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) {
    if (String(v[i][0]).trim() !== folio) continue;
    const url = String(v[i][14]).trim();
    if (url === CFG.PDF_PENDIENTE) throw new Error('El PDF de ' + folio + ' está pendiente. Regenéralo desde el menú de la planilla.');
    const m = url.match(/[-\w]{25,}/);
    if (!m) throw new Error('No se encontró el PDF de ' + folio + '.');
    const f = DriveApp.getFileById(m[0]);
    return { nombre: f.getName(), b64: Utilities.base64Encode(f.getBlob().getBytes()) };
  }
  throw new Error('Folio no encontrado: ' + folio);
}

function cerrarSesion() {
  if (USR) PropertiesService.getScriptProperties().deleteProperty('SES_' + USR.token);
  return { ok: true };
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('EPP / Insumos')
    .addItem('Configurar planilla (1ª vez / actualizar hojas)', 'setup')
    .addItem('Generar códigos faltantes', 'generarCodigosFaltantes')
    .addItem('Formatear RUT (sin puntos, con guion)', 'formatearRutsPersonal')
    .addItem('Regenerar PDF pendientes', 'regenerarPdfsPendientes')
    .addToUi();
}

/* ---------------- Utilidades ---------------- */

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SS_ID');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('El script no está vinculado a una planilla. Créalo desde la Sheet: Extensiones → Apps Script.');
  return ss;
}
function hoja_(k) {
  const sh = ss_().getSheetByName(H[k].n);
  if (!sh) throw new Error('Falta la hoja ' + H[k].n + '. Ejecuta "Configurar planilla".');
  return sh;
}
function normRut_(s) { return String(s || '').replace(/[^0-9kK]/g, '').toUpperCase(); }
/** 12.345.678-9 / 123456789 / 12345678-9  ->  12345678-9 */
function fmtRut_(s) {
  const r = normRut_(s);
  return r.length < 2 ? r : r.slice(0, -1) + '-' + r.slice(-1);
}
/** ¿El texto tiene forma de RUT? (evita "formatear" nombres u otros datos) */
function esRut_(s) { return /^\d{1,2}\.?\d{3}\.?\d{3}\s*-?\s*[\dkK]$/.test(String(s == null ? '' : s).trim()); }
/** Valida el dígito verificador (módulo 11). */
function rutValido_(s) {
  const r = normRut_(s);
  if (r.length < 8 || r.length > 9) return false;
  const cuerpo = r.slice(0, -1), dv = r.slice(-1);
  if (!/^\d+$/.test(cuerpo)) return false;
  let suma = 0, m = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) { suma += Number(cuerpo[i]) * m; m = m === 7 ? 2 : m + 1; }
  const res = 11 - (suma % 11);
  return dv === (res === 11 ? '0' : res === 10 ? 'K' : String(res));
}
function normNombre_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}
/** Deja la columna RUT de PERSONAL en formato sin puntos y con guion. Solo toca celdas que parecen RUT. */
function formatearRutsPersonal() {
  const sh = hoja_('PER');
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const rg = sh.getRange(2, 1, n, 1);
  const v = rg.getValues();
  let cambios = 0;
  const nv = v.map(x => {
    const raw = String(x[0]).trim();
    const f = esRut_(raw) ? fmtRut_(raw) : raw;
    if (f !== raw) cambios++;
    return [f];
  });
  if (cambios) { rg.setNumberFormat('@'); rg.setValues(nv); }
  return cambios;
}
function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function r2_(n) { return Math.round(n * 100) / 100; }
function carpeta_() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('CARPETA_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recrear */ } }
  const f = DriveApp.createFolder(CFG.CARPETA);
  p.setProperty('CARPETA_ID', f.getId());
  return f;
}
function subcarpeta_(padre, nombre) {
  const it = padre.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : padre.createFolder(nombre);
}
function trabajador_(rut) {
  const t = hoja_('PER').getDataRange().getValues().slice(1).find(r => normRut_(r[0]) === normRut_(rut));
  if (!t) throw new Error('Trabajador no encontrado en PERSONAL.');
  return { rut: fmtRut_(t[0]), nombre: String(t[1]).trim(), cargo: String(t[2]).trim(), turno: String(t[3]).trim() };
}
function siguienteFolio_(prop, pref) {
  const props = PropertiesService.getScriptProperties();
  const n = (Number(props.getProperty(prop)) || 0) + 1;
  props.setProperty(prop, String(n));
  return pref + String(n).padStart(6, '0');
}
function agregarFilas_(sh, filas, colsFecha, colHora) {
  const f = sh.getLastRow() + 1;
  sh.getRange(f, 1, filas.length, filas[0].length).setValues(filas);
  colsFecha.forEach(c => sh.getRange(f, c, filas.length, 1).setNumberFormat('dd-mm-yyyy'));
  if (colHora) sh.getRange(f, colHora, filas.length, 1).setNumberFormat('HH:mm');
  return f;
}

/* ---------------- Configuración inicial ---------------- */

function setup() {
  const ss = ss_();
  PropertiesService.getScriptProperties().setProperty('SS_ID', ss.getId());

  Object.keys(H).forEach(k => {
    const c = H[k];
    const sh = ss.getSheetByName(c.n) || ss.insertSheet(c.n);
    if (sh.getLastRow() === 0) {
      const color = (k.charAt(0) === 'I') ? '#0f5e57' : '#1f3a5f';
      sh.getRange(1, 1, 1, c.h.length).setValues([c.h])
        .setFontWeight('bold').setBackground(color).setFontColor('#ffffff');
      sh.setFrozenRows(1);
    }
  });
  ss.getSheetByName(H.IENT.n).getRange('D:D').setNumberFormat('@'); // Mes como texto (2026-10)
  ss.getSheetByName(H.PER.n).getRange('A:A').setNumberFormat('@');  // RUT como texto
  ss.getSheetByName(H.USR.n).getRange('A:A').setNumberFormat('@');
  ss.getSheetByName(H.USR.n).getRange('D:D').setNumberFormat('@');  // PIN como texto (no pierde ceros: 0123)

  const cat = ss.getSheetByName(H.CAT.n);
  if (cat.getLastRow() === 1) {
    cat.getRange(2, 1, 9, 7).setValues([
      ['', 'Casco de seguridad', 'Única', 'UN', 20, 5, 'SI'],
      ['', 'Lentes de seguridad claros', 'Única', 'UN', 50, 10, 'SI'],
      ['', 'Protector auditivo tipo tapón', 'Única', 'PAR', 100, 20, 'SI'],
      ['', 'Guantes de nitrilo', '9', 'PAR', 40, 10, 'SI'],
      ['', 'Guantes de nitrilo', '10', 'PAR', 40, 10, 'SI'],
      ['', 'Traje de agua', 'L', 'UN', 10, 3, 'SI'],
      ['', 'Traje de agua', 'XL', 'UN', 10, 3, 'SI'],
      ['', 'Botas de agua con puntera', '42', 'PAR', 6, 2, 'SI'],
      ['', 'Respirador medio rostro', 'M', 'UN', 8, 2, 'SI']
    ]);
  }
  const icat = ss.getSheetByName(H.ICAT.n);
  if (icat.getLastRow() === 1) {
    icat.getRange(2, 1, 9, 9).setValues([
      ['', 'Jabón mecánico', 'Bidón 5 L', 'Bidón', 5, 'L', 6, 2, 'SI'],
      ['', 'Limpiavidrios', 'Botella 1 L', 'Botella', 1, 'L', 12, 4, 'SI'],
      ['', 'Desengrasante', 'Bidón 20 L', 'Bidón', 20, 'L', 4, 1, 'SI'],
      ['', 'Desodorante ambiental', 'Aerosol 360 ml', 'Unidad', 0.36, 'L', 24, 6, 'SI'],
      ['', 'Bolsa de basura', '50x70 cm (paquete 10)', 'Paquete', 10, 'bolsas', 20, 5, 'SI'],
      ['', 'Bolsa de basura', '80x110 cm (paquete 10)', 'Paquete', 10, 'bolsas', 20, 5, 'SI'],
      ['', 'Bolsa de basura', '120x150 cm (paquete 10)', 'Paquete', 10, 'bolsas', 10, 3, 'SI'],
      ['', 'Papel higiénico', 'Rollo jumbo', 'Rollo', 1, 'rollos', 30, 10, 'SI'],
      ['', 'Toalla de papel', 'Rollo', 'Rollo', 1, 'rollos', 30, 10, 'SI']
    ]);
  }
  const area = ss.getSheetByName(H.AREA.n);
  if (area.getLastRow() === 1) {
    area.getRange(2, 1, 6, 2).setValues([
      ['Losa de lavado', 'SI'], ['Taller', 'SI'], ['Oficinas', 'SI'],
      ['Baños y camarines', 'SI'], ['Comedor', 'SI'], ['Bodega', 'SI']
    ]);
  }
  const per = ss.getSheetByName(H.PER.n);
  if (per.getLastRow() === 1) {
    per.getRange(2, 1, 1, 5).setValues([['11111111-1', 'TRABAJADOR DE EJEMPLO', 'Operador de lavado', 'Turno A', 'SI']]);
  }
  ['Hoja 1', 'Hoja1', 'Sheet1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  crearResumenInsumos_(ss);
  carpeta_();
  generarCodigosFaltantes();
  try {
    SpreadsheetApp.getUi().alert('Planilla lista. EPP: CATALOGO. Insumos: INS_CATALOGO. Nómina: PERSONAL. Áreas: AREAS. Accesos: USUARIOS.');
  } catch (e) { /* ejecutado desde el editor */ }
}

/** Hojas de reporte de insumos con fórmulas que se actualizan solas. */
function crearResumenInsumos_(ss) {
  const src = H.IENT.n + '!A2:P';
  let r = ss.getSheetByName('INS_RESUMEN');
  if (!r) {
    r = ss.insertSheet('INS_RESUMEN');
    r.getRange('A1').setValue('Mes (aaaa-mm):').setFontWeight('bold');
    r.getRange('B1').setFormula('=YEAR(TODAY())&"-"&IF(MONTH(TODAY())<10,"0","")&MONTH(TODAY())')
      .setBackground('#fff2cc').setFontWeight('bold');
    r.getRange('C1').setValue('← muestra el mes actual. Para ver otro mes escribe, por ejemplo, 2026-09')
      .setFontColor('#666666');
    const where = ' where D = \'"&$B$1&"\' ';
    const titulos = [['A3', 'CONSUMO POR INSUMO'], ['G3', 'CONSUMO POR ÁREA'], ['M3', 'RETIROS POR TRABAJADOR']];
    titulos.forEach(t => r.getRange(t[0]).setValue(t[1]).setFontWeight('bold').setFontColor('#0f5e57'));
    r.getRange('A4').setFormula('=IFERROR(QUERY(' + src + ',"select I, J, N, sum(L), sum(M)' + where +
      'group by I, J, N order by I label I \'Insumo\', J \'Presentación\', N \'Medida\', sum(L) \'Unidades\', sum(M) \'Consumo total\'",0),"Sin entregas en el mes")');
    r.getRange('G4').setFormula('=IFERROR(QUERY(' + src + ',"select E, I, N, sum(L), sum(M)' + where +
      'group by E, I, N order by E, I label E \'Área\', I \'Insumo\', N \'Medida\', sum(L) \'Unidades\', sum(M) \'Consumo total\'",0),"Sin entregas en el mes")');
    r.getRange('M4').setFormula('=IFERROR(QUERY(' + src + ',"select G, I, N, sum(L), sum(M)' + where +
      'group by G, I, N order by G, I label G \'Trabajador\', I \'Insumo\', N \'Medida\', sum(L) \'Unidades\', sum(M) \'Consumo total\'",0),"Sin entregas en el mes")');
    r.setFrozenRows(4);
  }
  let hst = ss.getSheetByName('INS_HISTORICO');
  if (!hst) {
    hst = ss.insertSheet('INS_HISTORICO');
    hst.getRange('A1').setValue('CONSUMO MENSUAL POR INSUMO (consumo total en su medida)').setFontWeight('bold').setFontColor('#0f5e57');
    hst.getRange('A2').setFormula('=IFERROR(QUERY(' + src + ',"select I, N, sum(M) where D <> \'\' group by I, N pivot D label I \'Insumo\', N \'Medida\'",0),"Sin datos")');
  }
}

/** Asigna códigos (EPP0001…, INS0001…) a los ítems de ambos catálogos que no tengan código. */
function generarCodigosFaltantes() {
  return genCodigos_('CAT', CFG.PREFIJO_CODIGO) + genCodigos_('ICAT', CFG.PREFIJO_CODIGO_INS);
}
function genCodigos_(k, pref) {
  const sh = ss_().getSheetByName(H[k].n);
  if (!sh) return 0;
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const v = sh.getRange(2, 1, n, 2).getValues();
  let max = 0;
  v.forEach(x => {
    const c = String(x[0]).trim().toUpperCase();
    const m = c.match(/(\d+)$/);
    if (c.indexOf(pref) === 0 && m) max = Math.max(max, Number(m[1]));
  });
  let cambios = 0;
  v.forEach(x => {
    if (!String(x[0]).trim() && String(x[1]).trim()) {
      max++;
      x[0] = pref + String(max).padStart(4, '0');
      cambios++;
    }
  });
  if (cambios) sh.getRange(2, 1, n, 1).setValues(v.map(x => [x[0]]));
  return cambios;
}

/* ---------------- Lectura para la app ---------------- */

function getDatos() {
  // Si faltan hojas (primera vez o actualización desde la versión solo-EPP), se crean solas.
  const ss = ss_();
  if (Object.keys(H).some(k => !ss.getSheetByName(H[k].n)) || !ss.getSheetByName('INS_RESUMEN')) setup();
  generarCodigosFaltantes();
  formatearRutsPersonal();
  const activo = v => String(v).trim().toUpperCase() !== 'NO';

  const catalogo = hoja_('CAT').getDataRange().getValues().slice(1)
    .filter(r => String(r[0]).trim() && String(r[1]).trim() && activo(r[6]))
    .map(r => ({
      codigo: String(r[0]).trim().toUpperCase(),
      epp: String(r[1]).trim(),
      talla: String(r[2]).trim(),
      pres: '',
      unidad: String(r[3] || 'UN').trim(),
      stock: Number(r[4]) || 0,
      min: Number(r[5]) || 0
    }));
  const insumos = hoja_('ICAT').getDataRange().getValues().slice(1)
    .filter(r => String(r[0]).trim() && String(r[1]).trim() && activo(r[8]))
    .map(r => ({
      codigo: String(r[0]).trim().toUpperCase(),
      epp: String(r[1]).trim(),
      talla: '',
      pres: String(r[2]).trim(),
      unidad: String(r[3] || 'UN').trim(),
      contenido: Number(r[4]) || 0,
      medida: String(r[5] || '').trim(),
      stock: Number(r[6]) || 0,
      min: Number(r[7]) || 0
    }));
  const personal = hoja_('PER').getDataRange().getValues().slice(1)
    .filter(r => String(r[1]).trim() && activo(r[4]))
    .map(r => ({
      rut: esRut_(r[0]) ? fmtRut_(r[0]) : '',     // si la celda no es un RUT, la app pedirá completarlo
      nombre: String(r[1]).trim(),
      cargo: String(r[2]).trim(),
      turno: String(r[3]).trim()
    }));
  const areas = hoja_('AREA').getDataRange().getValues().slice(1)
    .filter(r => String(r[0]).trim() && activo(r[1]))
    .map(r => String(r[0]).trim());
  return { catalogo: catalogo, insumos: insumos, personal: personal, areas: areas };
}

/* ---------------- Alta de trabajadores desde la app ---------------- */

/** Crea un trabajador en PERSONAL. Si el RUT ya existe, devuelve el registro existente. */
function crearTrabajador(p) {
  const rut = fmtRut_(p && p.rut);
  if (!rutValido_(rut)) throw new Error('RUT inválido: ' + (p && p.rut || '') + '. Revisa el dígito verificador.');
  const nombre = String(p.nombre || '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (nombre.length < 5) throw new Error('Ingresa el nombre completo del trabajador.');
  const cargo = String(p.cargo || '').trim();
  const turno = String(p.turno || '').trim();

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = hoja_('PER');
    const v = sh.getDataRange().getValues();
    for (let i = 1; i < v.length; i++) {
      if (normRut_(v[i][0]) === normRut_(rut)) {
        return { rut: fmtRut_(v[i][0]), nombre: String(v[i][1]).trim(), cargo: String(v[i][2]).trim(), turno: String(v[i][3]).trim(), existia: true };
      }
    }
    const f = sh.getLastRow() + 1;
    sh.getRange(f, 1).setNumberFormat('@');
    sh.getRange(f, 1, 1, 5).setValues([[rut, nombre, cargo, turno, 'SI']]);
    const nota = 'Creado desde la app el ' + Utilities.formatDate(new Date(), CFG.TZ, 'dd-MM-yyyy HH:mm') +
      (p.origen ? ' (' + p.origen + ')' : '') + (quien_(p.creadoPor) ? ' por ' + quien_(p.creadoPor) : '');
    sh.getRange(f, 2).setNote(nota);
    SpreadsheetApp.flush();
    return { rut: rut, nombre: nombre, cargo: cargo, turno: turno, existia: false };
  } finally {
    lock.releaseLock();
  }
}

/** Completa el RUT de un trabajador que en PERSONAL solo tenía nombre. */
function asignarRut(p) {
  const rut = fmtRut_(p && p.rut);
  if (!rutValido_(rut)) throw new Error('RUT inválido: ' + (p && p.rut || '') + '. Revisa el dígito verificador.');
  const nombre = normNombre_(p.nombre);
  if (!nombre) throw new Error('Falta el nombre del trabajador.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = hoja_('PER');
    const v = sh.getDataRange().getValues();
    let fila = -1;
    for (let i = 1; i < v.length; i++) {
      if (normRut_(v[i][0]) === normRut_(rut) && esRut_(v[i][0])) {
        throw new Error('Ese RUT ya está registrado a nombre de ' + String(v[i][1]).trim() + '.');
      }
      if (fila < 0 && normNombre_(v[i][1]) === nombre && !esRut_(v[i][0])) fila = i;
    }
    if (fila < 0) throw new Error('No se encontró a ' + p.nombre + ' sin RUT en PERSONAL.');
    sh.getRange(fila + 1, 1).setNumberFormat('@').setValue(rut);
    SpreadsheetApp.flush();
    return { rut: rut, nombre: String(v[fila][1]).trim(), cargo: String(v[fila][2]).trim(), turno: String(v[fila][3]).trim() };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- Registro de entrega de EPP ---------------- */

function registrarEntrega(p) {
  if (!p || !p.rut) throw new Error('El trabajador no tiene RUT en PERSONAL. Complétalo antes de registrar.');
  if (!p.items || !p.items.length) throw new Error('No hay EPP en la entrega.');
  if (!p.firma || p.firma.indexOf('data:image/png;base64,') !== 0) throw new Error('Falta la firma del trabajador.');
  const entregadoPor = quien_(p.entregadoPor);
  if (!entregadoPor) throw new Error('Indica quién entrega.');

  const pedido = {};
  p.items.forEach(i => {
    const c = String(i.codigo).trim().toUpperCase();
    const q = Math.floor(Number(i.cantidad));
    if (!(q > 0)) throw new Error('Cantidad inválida en ' + c);
    pedido[c] = (pedido[c] || 0) + q;
  });

  const ahora = new Date();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let folio, trab, filaIni, nFilas;
  const detalle = [];
  try {
    trab = trabajador_(p.rut);
    const shC = hoja_('CAT');
    const vc = shC.getDataRange().getValues();
    const idx = {};
    for (let i = 1; i < vc.length; i++) {
      const c = String(vc[i][0]).trim().toUpperCase();
      if (c) idx[c] = i;
    }
    Object.keys(pedido).forEach(c => {
      if (idx[c] === undefined) throw new Error('Código no existe en CATALOGO de EPP: ' + c);
    });

    folio = siguienteFolio_('FOLIO', CFG.PREFIJO_FOLIO);
    const filasE = [], filasM = [];
    Object.keys(pedido).forEach(c => {
      const i = idx[c], r = vc[i], q = pedido[c];
      const nuevo = (Number(r[4]) || 0) - q;
      shC.getRange(i + 1, 5).setValue(nuevo);
      detalle.push({ codigo: c, epp: String(r[1]), talla: String(r[2]), unidad: String(r[3] || 'UN'), cantidad: q, stock: nuevo, min: Number(r[5]) || 0 });
      // La columna PDF parte como PENDIENTE: si algo falla después, queda marcado y se regenera desde el menú.
      filasE.push([folio, ahora, ahora, trab.rut, trab.nombre, trab.cargo, trab.turno, c, r[1], r[2], q, p.motivo || '', entregadoPor, p.obs || '', CFG.PDF_PENDIENTE]);
      filasM.push([ahora, ahora, 'SALIDA', c, r[1], r[2], -q, nuevo, folio, entregadoPor, 'Entrega a ' + trab.nombre]);
    });
    nFilas = filasE.length;
    filaIni = agregarFilas_(hoja_('ENT'), filasE, [2], 3);
    agregarFilas_(hoja_('MOV'), filasM, [1], 2);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  const alertas = detalle.filter(d => d.stock <= d.min)
    .map(d => d.epp + (d.talla ? ' T' + d.talla : '') + ': quedan ' + d.stock);

  // Desde aquí la entrega YA está registrada. Si el PDF falla, se informa como pendiente (nunca se registra dos veces).
  let url = '';
  try {
    guardarFirma_(folio, ahora, p.firma);
    url = pdfEntrega_({
      folio: folio, ahora: ahora, trab: trab, detalle: detalle, motivo: p.motivo || '',
      obs: p.obs || '', entregadoPor: entregadoPor, firma: p.firma, hash: hash_(folio, trab.rut, detalle, ahora, p.firma)
    }).getUrl();
    hoja_('ENT').getRange(filaIni, 15, nFilas, 1).setValues(Array(nFilas).fill([url]));
  } catch (err) {
    console.error('PDF ' + folio + ': ' + (err && err.message));
    return { folio: folio, url: '', pdfPendiente: true, alertas: alertas };
  }
  return { folio: folio, url: url, pdfPendiente: false, alertas: alertas };
}

function hash_(folio, rut, detalle, ahora, firma) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    [folio, normRut_(rut), JSON.stringify(detalle.map(d => [d.codigo, d.cantidad])), ahora.toISOString(), firma].join('|'));
  return digest.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('').slice(0, 20).toUpperCase();
}

/** Guarda la firma como PNG (respaldo y fuente para regenerar el PDF). */
function guardarFirma_(folio, ahora, firma) {
  const b64 = firma.replace(/^data:image\/png;base64,/, '');
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/png', folio + '_firma.png');
  const mes = Utilities.formatDate(ahora, CFG.TZ, 'yyyy-MM');
  subcarpeta_(subcarpeta_(carpeta_(), 'Firmas'), mes).createFile(blob);
}
function leerFirma_(folio) {
  const it = subcarpeta_(carpeta_(), 'Firmas').searchFiles('title = "' + folio + '_firma.png"');
  if (it.hasNext()) return 'data:image/png;base64,' + Utilities.base64Encode(it.next().getBlob().getBytes());
  // búsqueda en subcarpetas por mes
  const meses = subcarpeta_(carpeta_(), 'Firmas').getFolders();
  while (meses.hasNext()) {
    const f = meses.next().getFilesByName(folio + '_firma.png');
    if (f.hasNext()) return 'data:image/png;base64,' + Utilities.base64Encode(f.next().getBlob().getBytes());
  }
  return '';
}

/** Menú: genera el PDF de todas las entregas marcadas "PDF PENDIENTE". */
function regenerarPdfsPendientes() {
  const sh = hoja_('ENT');
  const v = sh.getDataRange().getValues();
  const grupos = {};
  for (let i = 1; i < v.length; i++) {
    if (String(v[i][14]).trim() !== CFG.PDF_PENDIENTE) continue;
    const f = String(v[i][0]).trim();
    (grupos[f] = grupos[f] || []).push(i);
  }
  const unidades = {};
  hoja_('CAT').getDataRange().getValues().slice(1).forEach(r => { unidades[String(r[0]).trim().toUpperCase()] = String(r[3] || 'UN'); });

  const ok = [], sinFirma = [], error = [];
  Object.keys(grupos).forEach(folio => {
    try {
      const filas = grupos[folio].map(i => v[i]);
      const r0 = filas[0];
      const ahora = r0[1] instanceof Date ? r0[1] : new Date();
      const firma = leerFirma_(folio);
      if (!firma) { sinFirma.push(folio); return; }
      const trab = { rut: fmtRut_(r0[3]), nombre: String(r0[4]), cargo: String(r0[5]), turno: String(r0[6]) };
      const detalle = filas.map(r => ({ codigo: String(r[7]), epp: String(r[8]), talla: String(r[9]), unidad: unidades[String(r[7]).toUpperCase()] || 'UN', cantidad: Number(r[10]) || 0 }));
      const url = pdfEntrega_({
        folio: folio, ahora: ahora, trab: trab, detalle: detalle, motivo: String(r0[11]), obs: String(r0[13]),
        entregadoPor: String(r0[12]), firma: firma, hash: hash_(folio, trab.rut, detalle, ahora, firma)
      }).getUrl();
      grupos[folio].forEach(i => sh.getRange(i + 1, 15).setValue(url));
      ok.push(folio);
    } catch (e) {
      error.push(folio + ' (' + e.message + ')');
    }
  });
  const msg = 'PDF regenerados: ' + (ok.length ? ok.join(', ') : 'ninguno') +
    (sinFirma.length ? '\nSin firma guardada (hacer registro en papel o nueva entrega): ' + sinFirma.join(', ') : '') +
    (error.length ? '\nCon error: ' + error.join('; ') : '');
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
  return msg;
}

function pdfEntrega_(o) {
  const f = Utilities.formatDate(o.ahora, CFG.TZ, 'dd-MM-yyyy');
  const h = Utilities.formatDate(o.ahora, CFG.TZ, 'HH:mm');
  const filas = o.detalle.map((d, i) =>
    '<tr><td class="c">' + (i + 1) + '</td><td>' + esc_(d.codigo) + '</td><td>' + esc_(d.epp) +
    '</td><td class="c">' + esc_(d.talla) + '</td><td class="c">' + esc_(d.unidad) +
    '</td><td class="c">' + d.cantidad + '</td></tr>').join('');

  const html =
    '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#111;}' +
    'table{width:100%;border-collapse:collapse;margin-bottom:10px;}' +
    'td,th{border:1px solid #444;padding:5px 6px;vertical-align:middle;}' +
    'th{background:#1f3a5f;color:#fff;font-size:9pt;text-align:left;}' +
    '.c{text-align:center;} .lbl{background:#e8edf3;font-weight:bold;width:22%;}' +
    '.sec{background:#1f3a5f;color:#fff;font-weight:bold;padding:4px 6px;margin:12px 0 0 0;font-size:9.5pt;}' +
    '.decl{border:1px solid #444;padding:8px;font-size:9pt;text-align:justify;line-height:1.35;margin-bottom:10px;}' +
    '.pie{font-size:7.5pt;color:#555;margin-top:14px;}' +
    '</style></head><body>' +

    '<table><tr>' +
    '<td style="width:24%;font-size:15pt;font-weight:bold;" class="c">' + esc_(CFG.EMPRESA) + '</td>' +
    '<td class="c" style="font-weight:bold;font-size:11.5pt;">REGISTRO DE ENTREGA DE<br>ELEMENTOS DE PROTECCIÓN PERSONAL</td>' +
    '<td style="width:26%;font-size:8.5pt;">Código: ' + esc_(CFG.CODIGO_DOC) + '<br><b>Folio: ' + esc_(o.folio) +
    '</b><br>Fecha: ' + f + ' &nbsp; ' + h + '</td>' +
    '</tr></table>' +

    '<div class="sec">1. IDENTIFICACIÓN DEL TRABAJADOR</div>' +
    '<table>' +
    '<tr><td class="lbl">Nombre</td><td>' + esc_(o.trab.nombre) + '</td><td class="lbl">RUT</td><td>' + esc_(o.trab.rut) + '</td></tr>' +
    '<tr><td class="lbl">Cargo</td><td>' + esc_(o.trab.cargo) + '</td><td class="lbl">Turno</td><td>' + esc_(o.trab.turno) + '</td></tr>' +
    '<tr><td class="lbl">Faena</td><td colspan="3">' + esc_(CFG.FAENA) + '</td></tr>' +
    '<tr><td class="lbl">Motivo de entrega</td><td colspan="3">' + esc_(o.motivo) + '</td></tr>' +
    '</table>' +

    '<div class="sec">2. DETALLE DE EPP ENTREGADOS</div>' +
    '<table><tr><th class="c" style="width:6%">N°</th><th style="width:14%">Código</th><th>Descripción</th>' +
    '<th class="c" style="width:10%">Talla</th><th class="c" style="width:9%">Unidad</th><th class="c" style="width:9%">Cant.</th></tr>' +
    filas + '</table>' +
    (o.obs ? '<table><tr><td class="lbl">Observaciones</td><td>' + esc_(o.obs) + '</td></tr></table>' : '') +

    '<div class="sec">3. DECLARACIÓN DEL TRABAJADOR</div>' +
    '<div class="decl">Declaro haber recibido de ' + esc_(CFG.EMPRESA) + ', en forma gratuita y en buen estado, los elementos de ' +
    'protección personal individualizados en este registro, y haber sido instruido sobre su correcto uso, mantención, ' +
    'almacenamiento y limitaciones. Me comprometo a utilizarlos en forma permanente mientras me encuentre expuesto al riesgo ' +
    'para el cual fueron entregados, a cuidarlos, y a solicitar su reposición cuando presenten deterioro, daño o pérdida, ' +
    'conforme a lo dispuesto en el artículo 68 de la Ley N° 16.744, el artículo 53 del D.S. N° 594 y el Reglamento Interno ' +
    'de Orden, Higiene y Seguridad de la empresa.</div>' +

    '<table><tr>' +
    '<td class="c" style="width:50%;height:120px;"><img src="' + o.firma + '" style="height:95px;"></td>' +
    '<td class="c" style="width:50%;vertical-align:bottom;">' + esc_(o.entregadoPor) + '</td>' +
    '</tr><tr>' +
    '<td class="c"><b>Firma del trabajador</b><br>' + esc_(o.trab.nombre) + ' · ' + esc_(o.trab.rut) + '</td>' +
    '<td class="c"><b>Entregado por</b><br>' + esc_(CFG.EMPRESA) + '</td>' +
    '</tr></table>' +

    '<div class="pie">Documento generado electrónicamente el ' + f + ' a las ' + h + ' (hora de Chile). ' +
    'Firma capturada en dispositivo móvil al momento de la entrega. Código de verificación: ' + o.hash + '.</div>' +
    '</body></html>';

  const nombre = o.folio + '_' + normRut_(o.trab.rut) + '_' + o.trab.nombre.replace(/[^\wÁÉÍÓÚÑáéíóúñ ]/g, '').replace(/\s+/g, '_') + '.pdf';
  const blob = Utilities.newBlob(html, 'text/html', 'entrega.html').getAs('application/pdf').setName(nombre);
  const mes = Utilities.formatDate(o.ahora, CFG.TZ, 'yyyy-MM');
  return subcarpeta_(carpeta_(), mes).createFile(blob);
}

/* ---------------- Registro de entrega de INSUMOS ---------------- */

function registrarInsumos(p) {
  if (!p || !p.rut) throw new Error('El trabajador no tiene RUT en PERSONAL. Complétalo antes de registrar.');
  const area = String(p.area || '').trim();
  if (!area) throw new Error('Selecciona el área.');
  if (!p.items || !p.items.length) throw new Error('No hay insumos en la entrega.');
  const entregadoPor = quien_(p.entregadoPor);
  if (!entregadoPor) throw new Error('Indica quién entrega.');

  const pedido = {};
  p.items.forEach(i => {
    const c = String(i.codigo).trim().toUpperCase();
    const q = Math.floor(Number(i.cantidad));
    if (!(q > 0)) throw new Error('Cantidad inválida en ' + c);
    pedido[c] = (pedido[c] || 0) + q;
  });

  const ahora = new Date();
  const mes = Utilities.formatDate(ahora, CFG.TZ, 'yyyy-MM');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const trab = trabajador_(p.rut);
    const shC = hoja_('ICAT');
    const vc = shC.getDataRange().getValues();
    const idx = {};
    for (let i = 1; i < vc.length; i++) {
      const c = String(vc[i][0]).trim().toUpperCase();
      if (c) idx[c] = i;
    }
    Object.keys(pedido).forEach(c => {
      if (idx[c] === undefined) throw new Error('Código no existe en INS_CATALOGO: ' + c);
    });

    const folio = siguienteFolio_('FOLIO_INS', CFG.PREFIJO_FOLIO_INS);
    const filasE = [], filasM = [], alertas = [];
    Object.keys(pedido).forEach(c => {
      const i = idx[c], r = vc[i], q = pedido[c];
      const nuevo = (Number(r[6]) || 0) - q;
      shC.getRange(i + 1, 7).setValue(nuevo);
      const contenido = Number(r[4]) || 0;
      const medida = String(r[5] || '').trim() || String(r[3] || 'UN');
      const total = r2_(q * (contenido || 1));
      filasE.push([folio, ahora, ahora, mes, area, trab.rut, trab.nombre, c, r[1], r[2], r[3], q, total, medida, entregadoPor, p.obs || '']);
      filasM.push([ahora, ahora, 'SALIDA', c, r[1], r[2], -q, nuevo, folio, entregadoPor, area + ' · ' + trab.nombre]);
      if (nuevo <= (Number(r[7]) || 0)) alertas.push(r[1] + ' ' + r[2] + ': quedan ' + nuevo);
    });

    const shE = hoja_('IENT');
    const f = shE.getLastRow() + 1;
    shE.getRange(f, 4, filasE.length, 1).setNumberFormat('@');
    agregarFilas_(shE, filasE, [2], 3);
    agregarFilas_(hoja_('IMOV'), filasM, [1], 2);
    SpreadsheetApp.flush();
    return { folio: folio, alertas: alertas };
  } finally {
    lock.releaseLock();
  }
}

/** Resumen de consumo de insumos de un mes (aaaa-mm), por insumo y por área. */
function consumoInsumos(mes) {
  const v = hoja_('IENT').getDataRange().getValues().slice(1).filter(r => String(r[0]).trim());
  const mesDe = r => (r[3] instanceof Date) ? Utilities.formatDate(r[3], CFG.TZ, 'yyyy-MM') : String(r[3]).trim();
  const actual = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM');
  const meses = Array.from(new Set(v.map(mesDe).filter(Boolean).concat([actual]))).sort().reverse();
  mes = String(mes || actual);

  const fil = v.filter(r => mesDe(r) === mes);
  const porIns = {}, porArea = {};
  const sumar = (obj, r) => {
    const k = String(r[7]);
    const x = obj[k] = obj[k] || { insumo: String(r[8]), pres: String(r[9]), unidad: String(r[10]), medida: String(r[13]), cant: 0, total: 0 };
    x.cant += Number(r[11]) || 0;
    x.total = r2_(x.total + (Number(r[12]) || 0));
  };
  fil.forEach(r => {
    sumar(porIns, r);
    const a = String(r[4]) || 'Sin área';
    porArea[a] = porArea[a] || {};
    sumar(porArea[a], r);
  });
  const orden = (a, b) => a.insumo.localeCompare(b.insumo) || a.pres.localeCompare(b.pres);
  return {
    mes: mes,
    meses: meses,
    entregas: new Set(fil.map(r => r[0])).size,
    porInsumo: Object.keys(porIns).map(k => porIns[k]).sort(orden),
    porArea: Object.keys(porArea).sort().map(a => ({ area: a, items: Object.keys(porArea[a]).map(k => porArea[a][k]).sort(orden) }))
  };
}

/* ---------------- Ingreso de stock (ambos módulos) ---------------- */

function filaCat_(sh, c) {
  const v = sh.getDataRange().getValues();
  for (let k = 1; k < v.length; k++) if (String(v[k][0]).trim().toUpperCase() === c) return { i: k, r: v[k] };
  throw new Error('Código no existe en ' + sh.getName() + ': ' + c);
}

function ingresarStock(p) {
  const m = mod_(p && p.mod);
  const c = String(p && p.codigo || '').trim().toUpperCase();
  const q = Math.floor(Number(p && p.cantidad));
  if (!c) throw new Error('Selecciona un ítem.');
  if (!(q > 0)) throw new Error('Cantidad inválida.');
  const resp = quien_(p.responsable);
  if (!resp) throw new Error('Indica el responsable.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = hoja_(m.cat);
    const x = filaCat_(sh, c);
    const nuevo = (Number(x.r[m.iStock]) || 0) + q;
    sh.getRange(x.i + 1, m.iStock + 1).setValue(nuevo);
    const ahora = new Date();
    agregarFilas_(hoja_(m.mov), [[ahora, ahora, 'INGRESO', c, x.r[1], x.r[2], q, nuevo, p.documento || '', resp, p.obs || '']], [1], 2);
    SpreadsheetApp.flush();
    return { codigo: c, stock: nuevo };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- Ajuste por conteo físico (ambos módulos) ---------------- */

/** Reemplaza el stock del sistema por el conteo real y deja la diferencia trazada en movimientos. */
function ajustarStock(p) {
  const m = mod_(p && p.mod);
  const c = String(p && p.codigo || '').trim().toUpperCase();
  const real = Math.floor(Number(p && p.stockReal));
  if (!c) throw new Error('Selecciona un ítem.');
  if (!(real >= 0)) throw new Error('El stock real debe ser 0 o más.');
  const resp = quien_(p.responsable);
  if (!resp) throw new Error('Indica el responsable.');
  const motivo = String(p.motivo || '').trim();
  if (!motivo) throw new Error('Indica el motivo del ajuste.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = hoja_(m.cat);
    const x = filaCat_(sh, c);
    const anterior = Number(x.r[m.iStock]) || 0;
    const dif = real - anterior;
    sh.getRange(x.i + 1, m.iStock + 1).setValue(real);
    const ahora = new Date();
    const obs = 'Stock sistema ' + anterior + ' → conteo ' + real + (p.obs ? '. ' + p.obs : '');
    agregarFilas_(hoja_(m.mov), [[ahora, ahora, 'AJUSTE', c, x.r[1], x.r[2], dif, real, motivo, resp, obs]], [1], 2);
    SpreadsheetApp.flush();
    return { codigo: c, stock: real, diferencia: dif };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- Etiquetas QR ---------------- */

/** lista: [{codigo, epp, talla, pres, img (QR dataURL), bar (código de barras dataURL), copias}] -> URL de PDF en Drive */
function etiquetasPdf(lista, mod) {
  if (!lista || !lista.length) throw new Error('No hay etiquetas seleccionadas.');
  const celdas = [];
  lista.forEach(e => {
    const n = Math.max(1, Math.min(50, Math.floor(Number(e.copias) || 1)));
    for (let k = 0; k < n; k++) celdas.push(e);
  });
  let filas = '';
  for (let i = 0; i < celdas.length; i += 3) {
    filas += '<tr>';
    for (let j = 0; j < 3; j++) {
      const e = celdas[i + j];
      filas += e
        ? '<td>' +
          (e.img ? '<img src="' + e.img + '" style="width:120px;height:120px;"><br>' : '') +
          (e.bar ? '<img src="' + e.bar + '" style="width:190px;height:62px;"><br>' : '') +
          '<b style="font-size:10.5pt;">' + esc_(e.epp) + '</b><br>' +
          (e.talla ? 'Talla ' + esc_(e.talla) + '<br>' : '') +
          (e.pres ? esc_(e.pres) + '<br>' : '') +
          '<span style="font-size:9pt;color:#333;">' + esc_(e.codigo) + '</span></td>'
        : '<td style="border:none;"></td>';
    }
    filas += '</tr>';
  }
  const html = '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;}' +
    'table{width:100%;border-collapse:separate;border-spacing:8px;}' +
    'td{width:33%;border:1px dashed #777;text-align:center;padding:8px 4px;vertical-align:top;page-break-inside:avoid;}' +
    '</style></head><body><table>' + filas + '</table></body></html>';
  const ts = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd_HHmm');
  const pref = mod === 'ins' ? 'Etiquetas_INSUMOS_' : 'Etiquetas_EPP_';
  const blob = Utilities.newBlob(html, 'text/html', 'etiquetas.html').getAs('application/pdf').setName(pref + ts + '.pdf');
  const f = subcarpeta_(carpeta_(), 'Etiquetas').createFile(blob);
  // Se devuelve también el PDF para descargarlo en el celular sin pedir acceso a Drive.
  return { url: f.getUrl(), nombre: f.getName(), b64: Utilities.base64Encode(blob.getBytes()) };
}