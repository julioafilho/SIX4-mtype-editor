let pyodideReadyPromise = null;
let pyEngine = null;
let currentVarFile = null;
let currentVarBytes = null;
let currentStaticFiles = [];
let currentStaticBuffers = [];
let activeMode = 'variable';

// =========================================================================
// MOTOR PYTHON + FONTTOOLS EM WEBASSEMBLY (RODA 100% NO NAVEGADOR)
// =========================================================================
const PYTHON_FONT_ENGINE = `
import io
import json
import re
import zipfile
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

def validate_magic(data: bytes, filename: str) -> str:
    if len(data) < 4:
        raise ValueError(f"Arquivo '{filename}' inválido ou vazio.")
    magic = data[:4]
    if magic == b"\\x00\\x01\\x00\\x00":
        return ".ttf"
    elif magic == b"OTTO":
        return ".otf"
    raise ValueError(f"Assinatura binária inválida em '{filename}'. Apenas arquivos .ttf e .otf válidos são aceitos.")

def clean_num(val: float):
    rounded = round(float(val), 2)
    return int(rounded) if rounded.is_integer() else rounded

def sanitize_filename(text: str) -> str:
    cleaned = re.sub(r'[\\\\/*?:"<>|]', "", text).strip()
    return cleaned.replace(" ", "")

def update_font_names(font: TTFont, family_name: str, style_name: str):
    family_name = family_name.strip()
    style_name = style_name.strip()
    full_name = f"{family_name} {style_name}"
    ps_name = f"{sanitize_filename(family_name)}-{sanitize_filename(style_name)}"

    name_table = font["name"]
    target_ids = {
        1: family_name,
        2: style_name,
        3: f"1.000;SIX4-MType;{ps_name}",
        4: full_name,
        6: ps_name,
        16: family_name,
        17: style_name,
    }
    name_table.names = [n for n in name_table.names if n.nameID not in target_ids]
    for name_id, value in target_ids.items():
        name_table.setName(value, name_id, 3, 1, 0x409)
        name_table.setName(value, name_id, 1, 0, 0)

def inspect_variable_bytes(raw_js_bytes, filename: str) -> str:
    raw_bytes = bytes(raw_js_bytes)
    ext = validate_magic(raw_bytes, filename)
    font = TTFont(io.BytesIO(raw_bytes))
    if "fvar" not in font:
        font.close()
        raise ValueError("Este arquivo não possui a tabela 'fvar' (não é uma fonte variável).")

    name_table = font["name"]
    family_name = name_table.getDebugName(16) or name_table.getDebugName(1) or "Fonte"
    fvar = font["fvar"]

    axes_info = []
    for axis in fvar.axes:
        axis_label = name_table.getDebugName(axis.axisNameID) or axis.axisTag
        axes_info.append({
            "tag": axis.axisTag,
            "name": axis_label,
            "min": clean_num(axis.minValue),
            "max": clean_num(axis.maxValue),
            "default": clean_num(axis.defaultValue),
        })

    instances = []
    for idx, inst in enumerate(fvar.instances):
        style_name = name_table.getDebugName(inst.subfamilyNameID) or f"Style {idx + 1}"
        coords = {k: clean_num(v) for k, v in inst.coordinates.items()}
        instances.append({
            "index": idx,
            "default_style": style_name,
            "coordinates": coords,
        })

    font.close()
    return json.dumps({
        "filename": filename,
        "family_name": family_name,
        "extension": ext,
        "axes": axes_info,
        "instances": instances,
    })

def extract_variable_to_zip(raw_js_bytes, filename: str, selections_json: str) -> bytes:
    raw_bytes = bytes(raw_js_bytes)
    ext = validate_magic(raw_bytes, filename)
    selected_instances = json.loads(selections_json)

    zip_buffer = io.BytesIO()
    used_filenames = set()

    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in selected_instances:
            family_name = item.get("family_name", "Fonte").strip() or "Fonte"
            style_name = item.get("style_name", "Regular").strip() or "Regular"
            coords = {k: float(v) for k, v in item.get("coordinates", {}).items()}

            var_font = TTFont(io.BytesIO(raw_bytes))
            static_font = instancer.instantiateVariableFont(var_font, coords, inplace=False)
            if "STAT" in static_font:
                del static_font["STAT"]

            update_font_names(static_font, family_name, style_name)

            out_io = io.BytesIO()
            static_font.save(out_io)
            static_font.close()
            var_font.close()

            safe_fam = sanitize_filename(family_name)
            safe_sty = sanitize_filename(style_name)
            out_name = f"{safe_fam}-{safe_sty}{ext}"
            counter = 2
            while out_name in used_filenames:
                out_name = f"{safe_fam}-{safe_sty}-{counter}{ext}"
                counter += 1
            used_filenames.add(out_name)
            zf.writestr(out_name, out_io.getvalue())

    return zip_buffer.getvalue()

def inspect_static_batch(files_list) -> str:
    results = []
    detected_family = ""
    for idx, item in enumerate(files_list):
        filename = item["name"]
        raw_bytes = bytes(item["bytes"])
        try:
            ext = validate_magic(raw_bytes, filename)
            font = TTFont(io.BytesIO(raw_bytes))
            name_table = font["name"]
            fam = name_table.getDebugName(16) or name_table.getDebugName(1) or "Fonte"
            sub = name_table.getDebugName(17) or name_table.getDebugName(2) or "Regular"
            font.close()
            if not detected_family and fam:
                detected_family = fam
            results.append({
                "index": idx,
                "original_filename": filename,
                "detected_family": fam,
                "detected_style": sub,
                "extension": ext,
            })
        except Exception:
            continue

    if not results:
        raise ValueError("Nenhum arquivo .ttf ou .otf válido foi encontrado.")
    return json.dumps({"detected_family": detected_family, "files": results})

def rename_static_to_zip(files_list, selections_json: str) -> bytes:
    parsed = json.loads(selections_json)
    selected_map = {
        int(item["index"]): {
            "family_name": item.get("family_name", "Fonte"),
            "style_name": item.get("style_name", "Regular"),
        }
        for item in parsed
    }

    zip_buffer = io.BytesIO()
    used_filenames = set()

    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for idx, item in enumerate(files_list):
            if idx not in selected_map:
                continue
            filename = item["name"]
            raw_bytes = bytes(item["bytes"])
            ext = validate_magic(raw_bytes, filename)

            font = TTFont(io.BytesIO(raw_bytes))
            target_fam = selected_map[idx]["family_name"].strip() or "Fonte"
            target_sty = selected_map[idx]["style_name"].strip() or "Regular"
            update_font_names(font, target_fam, target_sty)

            out_io = io.BytesIO()
            font.save(out_io)
            font.close()

            safe_fam = sanitize_filename(target_fam) or "Fonte"
            safe_sty = sanitize_filename(target_sty) or "Regular"
            out_name = f"{safe_fam}-{safe_sty}{ext}"
            counter = 2
            while out_name in used_filenames:
                out_name = f"{safe_fam}-{safe_sty}-{counter}{ext}"
                counter += 1
            used_filenames.add(out_name)
            zf.writestr(out_name, out_io.getvalue())

    return zip_buffer.getvalue()
`;

async function ensurePyodideEngine() {
    if (pyEngine) return pyEngine;
    if (!pyodideReadyPromise) {
        pyodideReadyPromise = (async () => {
            const versionTag = document.getElementById("txt-footer-version");
            const originalTagText = versionTag ? versionTag.textContent : "MType Editor v1.0";
            if (versionTag) versionTag.textContent = "MType Editor v1.0 · Iniciando motor...";

            const pyodide = await loadPyodide();
            await pyodide.loadPackage("micropip");
            const micropip = pyodide.pyimport("micropip");
            await micropip.install("fonttools");
            await pyodide.runPythonAsync(PYTHON_FONT_ENGINE);
            pyEngine = pyodide;

            if (versionTag) versionTag.textContent = originalTagText;
            return pyodide;
        })();
    }
    return pyodideReadyPromise;
}

window.addEventListener("DOMContentLoaded", () => {
    ensurePyodideEngine().catch(() => {});
});

// =========================================================================
// 6. DICIONÁRIOS DA INDÚSTRIA TIPOGRÁFICA (WWS - Weight / Width / Slope)
// =========================================================================
const TYPOGRAPHY_WIDTH_RULES = [
    { canonical: 'UltraCompressed', regex: /\b(ultra[\s\-_]?compressed|ultracomp|ucmp)\b/i },
    { canonical: 'ExtraCompressed', regex: /\b(extra[\s\-_]?compressed|extracomp|xcmp)\b/i },
    { canonical: 'Compressed',      regex: /\b(compressed|comp|cmp)\b/i },
    { canonical: 'UltraCondensed',  regex: /\b(ultra[\s\-_]?condensed|ultracond|ucnd)\b/i },
    { canonical: 'ExtraCondensed',  regex: /\b(extra[\s\-_]?condensed|extracond|xcond|xcnd)\b/i },
    { canonical: 'SemiCondensed',   regex: /\b(semi[\s\-_]?condensed|semicond|scnd)\b/i },
    { canonical: 'Condensed',       regex: /\b(condensed|cond|cnd|cd)\b/i },
    { canonical: 'ExtraNarrow',     regex: /\b(extra[\s\-_]?narrow|xnarrow)\b/i },
    { canonical: 'Narrow',          regex: /\b(narrow|nar|nrw)\b/i },
    { canonical: 'SemiWide',        regex: /\b(semi[\s\-_]?wide|semiwide)\b/i },
    { canonical: 'UltraWide',       regex: /\b(ultra[\s\-_]?wide|ultrawide)\b/i },
    { canonical: 'ExtraWide',       regex: /\b(extra[\s\-_]?wide|extrawide|xwide|xwd)\b/i },
    { canonical: 'Wide',            regex: /\b(wide|wd)\b/i },
    { canonical: 'UltraExpanded',   regex: /\b(ultra[\s\-_]?expanded|ultraexp|uexp)\b/i },
    { canonical: 'ExtraExpanded',   regex: /\b(extra[\s\-_]?expanded|extraexp|xexp)\b/i },
    { canonical: 'SemiExpanded',    regex: /\b(semi[\s\-_]?expanded|semiexp|sexp)\b/i },
    { canonical: 'Expanded',        regex: /\b(expanded|exp|ex)\b/i },
    { canonical: 'Extended',        regex: /\b(extended|ext|xt)\b/i }
];

const TYPOGRAPHY_WEIGHT_RULES = [
    { canonical: 'ExtraBlack', regex: /\b(extra[\s\-_]?black|ultrablack|ultra[\s\-_]?black|xblack|xblk)\b/i },
    { canonical: 'Black',      regex: /\b(black|blk|heavy|hvy)\b/i },
    { canonical: 'ExtraBold',  regex: /\b(extra[\s\-_]?bold|ultrabold|ultra[\s\-_]?bold|xbold|xbld)\b/i },
    { canonical: 'SemiBold',   regex: /\b(semi[\s\-_]?bold|demibold|demi[\s\-_]?bold|sbold|sbld|demi)\b/i },
    { canonical: 'Bold',       regex: /\b(bold|bld)\b/i },
    { canonical: 'Medium',     regex: /\b(medium|med|md)\b/i },
    { canonical: 'Regular',    regex: /\b(regular|reg|normal|roman|book|bk)\b/i },
    { canonical: 'ExtraLight', regex: /\b(extra[\s\-_]?light|ultralight|ultra[\s\-_]?light|xlight|xlgt)\b/i },
    { canonical: 'Light',      regex: /\b(light|lgt|lt)\b/i },
    { canonical: 'Thin',       regex: /\b(thin|thn)\b/i },
    { canonical: 'Hairline',   regex: /\b(hairline|hair)\b/i }
];

const TYPOGRAPHY_SLOPE_RULES = [
    { canonical: 'Italic',  regex: /\b(italic|ital|ita|it)\b/i },
    { canonical: 'Oblique', regex: /\b(oblique|obl|ob)\b/i }
];

function parseTypographyNaming(baseFamily, rawSourceText) {
    const cleanSource = rawSourceText
        .replace(/\.(ttf|otf)$/i, '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[\-_]+/g, ' ');

    let detectedWidth = '';
    for (const rule of TYPOGRAPHY_WIDTH_RULES) {
        if (rule.regex.test(cleanSource)) {
            detectedWidth = rule.canonical;
            break;
        }
    }

    let detectedWeight = '';
    for (const rule of TYPOGRAPHY_WEIGHT_RULES) {
        if (rule.regex.test(cleanSource)) {
            detectedWeight = rule.canonical;
            break;
        }
    }

    let detectedSlope = '';
    for (const rule of TYPOGRAPHY_SLOPE_RULES) {
        if (rule.regex.test(cleanSource)) {
            detectedSlope = rule.canonical;
            break;
        }
    }

    let cleanBaseFamily = baseFamily.trim();
    for (const rule of TYPOGRAPHY_WIDTH_RULES) {
        cleanBaseFamily = cleanBaseFamily.replace(rule.regex, '').trim();
    }

    const suggestedFamily = detectedWidth
        ? `${cleanBaseFamily} ${detectedWidth}`.replace(/\s+/g, ' ').trim()
        : cleanBaseFamily;

    let suggestedStyle = '';
    if (detectedWeight && detectedSlope) {
        suggestedStyle = `${detectedWeight} ${detectedSlope}`;
    } else if (detectedWeight) {
        suggestedStyle = detectedWeight;
    } else if (detectedSlope) {
        suggestedStyle = detectedSlope;
    } else {
        suggestedStyle = 'Regular';
    }

    return {
        family: suggestedFamily,
        widthTag: detectedWidth || 'Normal',
        style: suggestedStyle
    };
}

// ==========================================
// CONTROLE DE TEMA E NAVEGAÇÃO INTERATIVA
// ==========================================
function toggleTheme() {
    const html = document.documentElement;
    const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('mtype-editor-theme', next);
}

(function initTheme() {
    const saved = localStorage.getItem('mtype-editor-theme');
    if (saved === 'light' || saved === 'dark') {
        document.documentElement.setAttribute('data-theme', saved);
    }
})();

function switchMode(mode) {
    activeMode = mode;
    const track = document.getElementById('mode-switch-track');
    track.setAttribute('data-active', mode);

    document.getElementById('tab-btn-variable').classList.toggle('active', mode === 'variable');
    document.getElementById('tab-btn-static').classList.toggle('active', mode === 'static');

    const sub = document.getElementById('header-subtitle');
    if (mode === 'variable') {
        document.getElementById('section-variable').classList.remove('hidden');
        document.getElementById('section-static').classList.add('hidden');
        sub.innerHTML = 'Carregue uma fonte variável <strong>.ttf</strong> ou <strong>.otf</strong>, escolha as instâncias, padronize a nomenclatura da família, do estilo, e exporte os arquivos prontos para instalar.';
    } else {
        document.getElementById('section-variable').classList.add('hidden');
        document.getElementById('section-static').classList.remove('hidden');
        sub.innerHTML = 'Carregue fontes estáticas <strong>.ttf</strong> ou <strong>.otf</strong>, filtre larguras, estilos, e padronize-os para agrupar a família.';
    }
}

function clearLoadedFonts() {
    currentVarFile = null;
    currentVarBytes = null;
    currentStaticFiles = [];
    currentStaticBuffers = [];

    document.getElementById('var-file-input').value = '';
    document.getElementById('var-file-chosen').textContent = 'Nenhum arquivo selecionado';
    document.getElementById('var-summary').classList.add('hidden');
    document.getElementById('var-groups-container').textContent = '';
    document.getElementById('var-footer').classList.add('hidden');
    showStatus('var-status', '');

    document.getElementById('static-folder-input').value = '';
    document.getElementById('static-files-input').value = '';
    document.getElementById('static-chosen-label').textContent = 'Nenhuma pasta ou arquivo selecionado';
    document.getElementById('static-summary').classList.add('hidden');
    document.getElementById('static-groups-container').textContent = '';
    document.getElementById('static-footer').classList.add('hidden');
    showStatus('static-status', '');

    document.getElementById('filter-search-input').value = '';
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
}

function showStatus(id, text, isError = false) {
    const el = document.getElementById(id);
    if (!text) {
        el.classList.add('hidden');
        return;
    }
    el.textContent = text;
    el.className = 'status-msg ' + (isError ? 'error' : '');
}

// ==========================================
// 6. FILTRO DE BUSCA E AUTO-PADRONIZAÇÃO
// ==========================================
function quickFilter(term) {
    const input = document.getElementById('filter-search-input');
    input.value = term;
    document.querySelectorAll('.chip').forEach(c => {
        c.classList.toggle('active', term !== '' && c.textContent.toLowerCase() === term.toLowerCase());
    });
    applyLiveFilter(term);
}

function applyLiveFilter(query) {
    const q = query.trim().toLowerCase();
    const containerId = activeMode === 'variable' ? 'var-groups-container' : 'static-groups-container';
    const cards = document.querySelectorAll(`#${containerId} .group-card`);

    cards.forEach(card => {
        const familyVal = (card.querySelector('.group-family-input')?.value || '').toLowerCase();
        const groupTitle = (card.querySelector('.group-title-text')?.textContent || '').toLowerCase();
        let visibleRows = 0;

        card.querySelectorAll('.instance-row').forEach(row => {
            const styleVal = (row.querySelector('.row-style-input')?.value || '').toLowerCase();
            const metaVal = (row.querySelector('.coord-label')?.textContent || '').toLowerCase();
            const rawVal = (row.dataset.rawSource || '').toLowerCase();

            const match = !q ||
                familyVal.includes(q) ||
                groupTitle.includes(q) ||
                styleVal.includes(q) ||
                metaVal.includes(q) ||
                rawVal.includes(q);

            row.classList.toggle('hidden', !match);
            if (match) visibleRows++;
        });

        card.classList.toggle('hidden', visibleRows === 0);
    });
}

function applyIndustrySmartRename() {
    const containerId = activeMode === 'variable' ? 'var-groups-container' : 'static-groups-container';
    const cards = document.querySelectorAll(`#${containerId} .group-card`);

    cards.forEach(card => {
        const famInput = card.querySelector('.group-family-input');
        const baseFam = famInput.dataset.baseFamily || famInput.value;
        let groupDetectedFamily = null;

        card.querySelectorAll('.instance-row').forEach(row => {
            const styleInput = row.querySelector('.row-style-input');
            const rawSource = row.dataset.rawSource || styleInput.value;
            const parsed = parseTypographyNaming(baseFam, rawSource);

            styleInput.value = parsed.style;
            if (!groupDetectedFamily && parsed.family) {
                groupDetectedFamily = parsed.family;
            }
        });

        if (groupDetectedFamily) {
            famInput.value = groupDetectedFamily;
        }
    });
}

// ==========================================
// RENDERIZAÇÃO COMPARTILHADA DE CARTÕES DE GRUPO
// ==========================================
function createGroupCardElement({ groupTitle, badgeText, defaultFamily, baseFamily, items }) {
    const card = document.createElement('div');
    card.className = 'card group-card';

    const header = document.createElement('div');
    header.className = 'group-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'group-header-left';

    const masterCb = document.createElement('input');
    masterCb.type = 'checkbox';
    masterCb.className = 'checkbox';
    masterCb.checked = true;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'group-title-text';
    titleSpan.textContent = groupTitle;

    headerLeft.appendChild(masterCb);
    headerLeft.appendChild(titleSpan);
    header.appendChild(headerLeft);

    if (badgeText) {
        const badge = document.createElement('span');
        badge.className = 'group-tag';
        badge.textContent = badgeText;
        header.appendChild(badge);
    }
    card.appendChild(header);

    const famRow = document.createElement('div');
    famRow.className = 'family-field-row';

    const famLabel = document.createElement('label');
    famLabel.textContent = 'Nome da família';

    const famInput = document.createElement('input');
    famInput.type = 'text';
    famInput.className = 'input input-family group-family-input';
    famInput.value = defaultFamily;
    famInput.dataset.baseFamily = baseFamily || defaultFamily;

    famRow.appendChild(famLabel);
    famRow.appendChild(famInput);
    card.appendChild(famRow);

    const grid = document.createElement('div');
    grid.className = 'instances-grid';

    items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'instance-row';
        row.dataset.rawSource = item.rawSource;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'checkbox row-cb';
        cb.checked = true;
        if (item.coords) cb.dataset.coords = JSON.stringify(item.coords);
        if (item.fileIndex !== undefined) cb.dataset.index = item.fileIndex;

        const styleInput = document.createElement('input');
        styleInput.type = 'text';
        styleInput.className = 'input row-style-input';
        styleInput.value = item.styleName;

        const metaSpan = document.createElement('span');
        metaSpan.className = 'coord-label';
        metaSpan.textContent = item.metaLabel;

        row.appendChild(cb);
        row.appendChild(styleInput);
        row.appendChild(metaSpan);
        grid.appendChild(row);
    });

    masterCb.addEventListener('change', () => {
        grid.querySelectorAll('.instance-row:not(.hidden) .row-cb').forEach(c => {
            c.checked = masterCb.checked;
        });
    });

    card.appendChild(grid);
    return card;
}

// ==========================================
// FUNÇÃO 1: FONTE VARIÁVEL (VIA PYODIDE WASM)
// ==========================================
document.getElementById('var-file-input').addEventListener('change', async (e) => {
    if (!e.target.files.length) return;
    const file = e.target.files[0];
    currentVarFile = file;
    document.getElementById('var-file-chosen').textContent = file.name;
    showStatus('var-status', 'Analisando tabela fvar...');

    try {
        const pyodide = await ensurePyodideEngine();
        const arrayBuffer = await file.arrayBuffer();
        currentVarBytes = new Uint8Array(arrayBuffer);

        const inspectFn = pyodide.globals.get("inspect_variable_bytes");
        const jsonResult = inspectFn(currentVarBytes, file.name);
        const data = JSON.parse(jsonResult);

        showStatus('var-status', '');
        populateVariableWorkspace(data);
    } catch (err) {
        showStatus('var-status', err.message || String(err), true);
    }
});

function populateVariableWorkspace(data) {
    document.getElementById('var-summary').classList.remove('hidden');
    document.getElementById('var-meta-line').textContent =
        `${data.filename} · fonte variável · família: ${data.family_name}`;

    const axesContainer = document.getElementById('var-axes-list');
    axesContainer.textContent = '';
    data.axes.forEach(ax => {
        const pill = document.createElement('span');
        pill.className = 'axis-badge';
        pill.textContent = `${ax.name} (${ax.tag}) ${ax.min}–${ax.max}, padrão ${ax.default}`;
        axesContainer.appendChild(pill);
    });

    const container = document.getElementById('var-groups-container');
    container.textContent = '';

    const hasWidthAxis = data.axes.some(a => a.tag === 'wdth');
    const groupsMap = new Map();

    data.instances.forEach(inst => {
        const key = (hasWidthAxis && inst.coordinates.wdth !== undefined)
            ? `Width ${inst.coordinates.wdth}`
            : 'Instâncias da Família';
        if (!groupsMap.has(key)) groupsMap.set(key, []);
        groupsMap.get(key).push(inst);
    });

    groupsMap.forEach((groupInstances, groupTitle) => {
        const sampleParsed = parseTypographyNaming(data.family_name, groupInstances[0].default_style);
        const items = groupInstances.map(inst => ({
            rawSource: inst.default_style,
            styleName: inst.default_style,
            coords: inst.coordinates,
            metaLabel: Object.entries(inst.coordinates).map(([k, v]) => `${k}=${v}`).join(' ')
        }));

        const card = createGroupCardElement({
            groupTitle,
            badgeText: sampleParsed.widthTag !== 'Normal' ? sampleParsed.widthTag : `${items.length} estilos`,
            defaultFamily: data.family_name,
            baseFamily: data.family_name,
            items
        });
        container.appendChild(card);
    });

    document.getElementById('var-footer').classList.remove('hidden');
}

async function extractVariableZip() {
    const selections = [];
    document.querySelectorAll('#var-groups-container .group-card').forEach(card => {
        const familyName = card.querySelector('.group-family-input').value.trim() || 'Fonte';
        card.querySelectorAll('.instance-row').forEach(row => {
            const cb = row.querySelector('.row-cb');
            const styleInput = row.querySelector('.row-style-input');
            if (cb.checked) {
                selections.push({
                    family_name: familyName,
                    style_name: styleInput.value.trim() || 'Regular',
                    coordinates: JSON.parse(cb.dataset.coords)
                });
            }
        });
    });

    if (!selections.length) {
        return showStatus('var-status', 'Selecione pelo menos uma instância para extrair.', true);
    }

    if (!currentVarFile || !currentVarBytes) {
        return showStatus('var-status', 'Modo de demonstração ativo: carregue um arquivo .ttf/.otf real para baixar o .zip.', false);
    }

    showStatus('var-status', 'Gerando arquivos estáticos e compactando .zip na memória...');

    try {
        const pyodide = await ensurePyodideEngine();
        const extractFn = pyodide.globals.get("extract_variable_to_zip");
        const zipProxy = extractFn(currentVarBytes, currentVarFile.name, JSON.stringify(selections));
        const zipUint8 = zipProxy.toJs({ create_proxies: false });
        zipProxy.destroy();

        const firstFam = selections[0].family_name.replace(/\s+/g, '');
        downloadBlob(new Blob([zipUint8], { type: "application/zip" }), `${firstFam}-Static.zip`);
        showStatus('var-status', 'Download concluído!');
    } catch (err) {
        showStatus('var-status', err.message || String(err), true);
    }
}

// ==========================================
// FUNÇÃO 2: PASTA / ARQUIVOS ESTÁTICOS (VIA PYODIDE WASM)
// ==========================================
document.getElementById('static-folder-input').addEventListener('change', e => handleStaticFiles(e.target.files));
document.getElementById('static-files-input').addEventListener('change', e => handleStaticFiles(e.target.files));

async function handleStaticFiles(fileList) {
    const valid = Array.from(fileList).filter(f => /\.(ttf|otf)$/i.test(f.name));
    if (!valid.length) {
        return showStatus('static-status', 'Nenhum arquivo .ttf ou .otf encontrado na seleção.', true);
    }

    currentStaticFiles = valid;
    document.getElementById('static-chosen-label').textContent = `${valid.length} arquivos carregados`;
    showStatus('static-status', 'Lendo metadados e identificando larguras/estilos...');

    try {
        const pyodide = await ensurePyodideEngine();
        currentStaticBuffers = [];
        for (const f of valid) {
            const buf = await f.arrayBuffer();
            currentStaticBuffers.push({
                name: f.name.split("/").pop(),
                bytes: new Uint8Array(buf)
            });
        }

        const inspectStaticFn = pyodide.globals.get("inspect_static_batch");
        const jsonResult = inspectStaticFn(pyodide.toPy(currentStaticBuffers));
        const data = JSON.parse(jsonResult);

        showStatus('static-status', '');
        populateStaticWorkspace(data);
    } catch (err) {
        showStatus('static-status', err.message || String(err), true);
    }
}

function populateStaticWorkspace(data) {
    document.getElementById('static-summary').classList.remove('hidden');
    document.getElementById('static-meta-line').textContent =
        `${data.files.length} fontes estáticas · família base detectada: ${data.detected_family}`;

    const container = document.getElementById('static-groups-container');
    container.textContent = '';

    const groupsMap = new Map();
    data.files.forEach(fileInfo => {
        const combinedSource = `${fileInfo.original_filename} ${fileInfo.detected_style}`;
        const parsed = parseTypographyNaming(data.detected_family, combinedSource);
        const groupKey = parsed.family;

        if (!groupsMap.has(groupKey)) {
            groupsMap.set(groupKey, {
                widthTag: parsed.widthTag,
                items: []
            });
        }
        groupsMap.get(groupKey).items.push({
            fileIndex: fileInfo.index,
            rawSource: combinedSource,
            styleName: parsed.style,
            metaLabel: fileInfo.original_filename
        });
    });

    groupsMap.forEach((groupData, suggestedFamily) => {
        const card = createGroupCardElement({
            groupTitle: groupData.widthTag === 'Normal' ? 'Família Padrão' : `Subfamília ${groupData.widthTag}`,
            badgeText: `${groupData.items.length} arquivos`,
            defaultFamily: suggestedFamily,
            baseFamily: data.detected_family,
            items: groupData.items
        });
        container.appendChild(card);
    });

    document.getElementById('static-footer').classList.remove('hidden');
}

async function renameStaticZip() {
    const selections = [];
    document.querySelectorAll('#static-groups-container .group-card').forEach(card => {
        const familyName = card.querySelector('.group-family-input').value.trim() || 'Fonte';
        card.querySelectorAll('.instance-row').forEach(row => {
            const cb = row.querySelector('.row-cb');
            const styleInput = row.querySelector('.row-style-input');
            if (cb.checked) {
                selections.push({
                    index: parseInt(cb.dataset.index, 10),
                    family_name: familyName,
                    style_name: styleInput.value.trim() || 'Regular'
                });
            }
        });
    });

    if (!selections.length) {
        return showStatus('static-status', 'Selecione pelo menos um arquivo.', true);
    }

    if (!currentStaticFiles.length || !currentStaticBuffers.length) {
        return showStatus('static-status', 'Modo de demonstração ativo: selecione uma pasta real para baixar o .zip.', false);
    }

    showStatus('static-status', 'Reescrevendo tabela name (IDs 1, 2, 4, 6, 16, 17) e gerando .zip...');

    try {
        const pyodide = await ensurePyodideEngine();
        const renameFn = pyodide.globals.get("rename_static_to_zip");
        const zipProxy = renameFn(pyodide.toPy(currentStaticBuffers), JSON.stringify(selections));
        const zipUint8 = zipProxy.toJs({ create_proxies: false });
        zipProxy.destroy();

        const firstFam = selections[0].family_name.replace(/\s+/g, '');
        downloadBlob(new Blob([zipUint8], { type: "application/zip" }), `${firstFam}-Family.zip`);
        showStatus('static-status', 'Download concluído!');
    } catch (err) {
        showStatus('static-status', err.message || String(err), true);
    }
}

function downloadBlob(blob, filename) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
}

// ==========================================
// DADOS DE EXEMPLO (BOTÕES "TESTAR")
// ==========================================
function loadDemoVariablePreview() {
    document.getElementById('var-file-chosen').textContent = 'AktivGrotesk-VF.ttf';
    populateVariableWorkspace({
        filename: 'AktivGrotesk-VF.ttf',
        family_name: 'Aktiv Grotesk',
        axes: [
            { name: 'Weight', tag: 'wght', min: 100, max: 900, default: 400 },
            { name: 'Width', tag: 'wdth', min: 75, max: 125, default: 100 },
            { name: 'Italic', tag: 'ital', min: 0, max: 1, default: 0 }
        ],
        instances: [
            { default_style: 'Cd Light', coordinates: { wght: 300, wdth: 75, ital: 0 } },
            { default_style: 'Cd Regular', coordinates: { wght: 400, wdth: 75, ital: 0 } },
            { default_style: 'Cd Bold', coordinates: { wght: 700, wdth: 75, ital: 0 } },
            { default_style: 'Cd Bold Italic', coordinates: { wght: 700, wdth: 75, ital: 1 } },
            { default_style: 'Light', coordinates: { wght: 300, wdth: 100, ital: 0 } },
            { default_style: 'Regular', coordinates: { wght: 400, wdth: 100, ital: 0 } },
            { default_style: 'Bold', coordinates: { wght: 700, wdth: 100, ital: 0 } },
            { default_style: 'Black Italic', coordinates: { wght: 900, wdth: 100, ital: 1 } },
            { default_style: 'Ex Regular', coordinates: { wght: 400, wdth: 125, ital: 0 } },
            { default_style: 'Ex Bold', coordinates: { wght: 700, wdth: 125, ital: 0 } }
        ]
    });
}

function loadDemoStaticPreview() {
    document.getElementById('static-chosen-label').textContent = '8 arquivos na pasta';
    populateStaticWorkspace({
        detected_family: 'MType Sans',
        files: [
            { index: 0, original_filename: 'MTypeSans-CondensedLight.ttf', detected_style: 'Condensed Light' },
            { index: 1, original_filename: 'MTypeSans-CondensedBoldItalic.ttf', detected_style: 'Condensed Bold Italic' },
            { index: 2, original_filename: 'MTypeSans-CompressedBlack.ttf', detected_style: 'Compressed Black' },
            { index: 3, original_filename: 'MTypeSans-Regular.ttf', detected_style: 'Regular' },
            { index: 4, original_filename: 'MTypeSans-Bold.ttf', detected_style: 'Bold' },
            { index: 5, original_filename: 'MTypeSans-BoldItalic.ttf', detected_style: 'Bold Italic' },
            { index: 6, original_filename: 'MTypeSans-WideRegular.ttf', detected_style: 'Wide Regular' },
            { index: 7, original_filename: 'MTypeSans-ExtraWideBlack.ttf', detected_style: 'ExtraWide Black' }
        ]
    });
}