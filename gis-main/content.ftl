<#-- GetFeatureInfo, log-style, ONE viewer link via index.html (TIF-first, folder -> ?prefix=...) -->

<#-- ===== CONFIG ===== -->
<#assign BASE = "https://ticketviewgis.s3.ca-central-1.amazonaws.com" />
<#assign ZIP_SEGMENT = "ZIP 4" />  <#-- keep plain; we encode later -->
<#assign EXT_ORDER = [".TIF", ".PDF"] />  <#-- prefer TIF; swap to prefer PDF -->

<style>
  pre { font:13px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
  a.asbuilt { text-decoration: underline; }
  .muted { color:#777; }
</style>

<#-- ===== HELPERS ===== -->
<#-- encode a single PATH SEGMENT (not slashes) -->
<#function enc_seg s>
  <#if !s?has_content><#return "" /></#if>
  <#local t = s?trim
                 ?replace("%","%25","r")
                 ?replace("&","%26","r")
                 ?replace("\\+","%2B","r")
                 ?replace("#","%23","r")
                 ?replace("\\s","%20","r") />
  <#return t>
</#function>

<#-- turn a PATH (with /) into a query-param value where / -> %2F -->
<#function qp_from_path path>
  <#if !path?has_content><#return "" /></#if>
  <#return path?replace("/","%2F","r")>
</#function>

<#function normalizeId raw>
  <#if !raw?has_content><#return "" /></#if>
  <#local up = raw?upper_case />
  <#local noext = up?replace("\\..*$","","r") />
  <#return noext?replace("[ _]+","-","r") />
</#function>

<#function hasHyphen s><#return s?contains("-") /></#function>

<#-- If ID has '-', folder is the token before '-'; else the whole ID is the folder -->
<#function folderFrom normId>
  <#if !normId?has_content><#return "" /></#if>
  <#if hasHyphen(normId)>
    <#local before = normId?keep_before("-")!"" />
    <#return (before?has_content)?then(before,(normId?length>=6)?then(normId?substring(0,6),"")) />
  <#else>
    <#return normId />
  </#if>
</#function>

<#-- Utility folder from feature first (RegionalDivision), else layer prefix -->
<#function canonicalUtilFromFeature f>
  <#local rd = ((f["RegionalDivision"]?if_exists.value)! "")?upper_case />
  <#if rd?starts_with("WASTE") || rd?starts_with("SANIT") || rd?starts_with("SEWER")><#return "WasteWater" />
  <#elseif rd?starts_with("STORM") || rd?starts_with("DRAIN")><#return "Storm" />
  <#elseif rd?starts_with("WATER")><#return "Water" />
  <#else><#return "" /></#if>
</#function>

<#function canonicalUtilFromLayer lname>
  <#local ln = (lname!"")?upper_case />
  <#if ln?starts_with("RWWN")><#return "WasteWater" />
  <#elseif ln?starts_with("RSW")><#return "Storm" />
  <#elseif ln?starts_with("RWN") || ln?starts_with("WATER")><#return "Water" />
  <#else><#return "Water" /></#if>
</#function>

<#function chooseUtilityFolder lname f>
  <#local fromFeat = canonicalUtilFromFeature(f) />
  <#if fromFeat?has_content><#return fromFeat /></#if>
  <#return canonicalUtilFromLayer(lname) />
</#function>

<#function areaFor f>
  <#local settlement = (f["Settlement"]?if_exists.value)!"" />
  <#local muni      = (f["Municipality"]?if_exists.value)!"" />
  <#return settlement?has_content?then(settlement, muni?has_content?then(muni, "Region-Wide")) />
</#function>

<#-- NEW: derive ID from DataSource like BR2405_03 -> BR2405-003, or BR2405 -> BR2405 -->
<#function deriveIdFromDataSource f>
  <#local ds = ((f["DataSource"]?if_exists.value)! "")?upper_case?trim />
  <#if !ds?has_content><#return "" /></#if>

  <#-- base + suffix (1–3 digits) -->
  <#if ds?matches(".*[A-Z]{1,3}\\d{3,5}[-_ ]?\\d{1,3}.*")>
    <#local base = ds?replace("^.*?([A-Z]{1,3}\\d{3,5}).*$","$1","r") />
    <#local suf  = ds?replace("^.*?[A-Z]{1,3}\\d{3,5}[-_ ]?(\\d{1,3}).*$","$1","r") />
    <#local suf3 = (suf?length==1)?then("00"+suf,(suf?length==2)?then("0"+suf,suf)) />
    <#return base + "-" + suf3 />
  </#if>

  <#-- base only -->
  <#if ds?matches(".*[A-Z]{1,3}\\d{3,5}.*")>
    <#return ds?replace("^.*?([A-Z]{1,3}\\d{3,5}).*$","$1","r") />
  </#if>

  <#return "" />
</#function>

<#-- NEW: zero-pad suffix to 3 digits, used ONLY when derived from DataSource -->
<#function padSuffix3 id>
  <#if id?matches("^[A-Z]{1,3}\\d{3,5}-\\d{1,3}$")>
    <#local suf  = id?replace("^.*-(\\d{1,3})$","$1","r") />
    <#local base = id?keep_before_last("-") />
    <#local suf3 = (suf?length==1)?then("00"+suf,(suf?length==2)?then("0"+suf,suf)) />
    <#return base + "-" + suf3 />
  </#if>
  <#return id />
</#function>

<#-- Prefer AsBuiltNumber, else DrawingNumber (fallback handled in viewerUrl) -->
<#function rawNumberDirect f>
  <#return (f["AsBuiltNumber"]?if_exists.value)!((f["DrawingNumber"]?if_exists.value)!"") />
</#function>

<#function layerNameFrom tOrName>
  <#if tOrName?is_string><#return tOrName><#else><#return (tOrName.name)!((tOrName.title)!"")></#if>
</#function>

<#-- Build a SINGLE viewer URL:
    - If ID has '-', file → .../index.html?view=<path to file>
    - If no '-', folder → .../index.html?prefix=<path to folder/> (with trailing slash)
    ID selection: AsBuiltNumber > DrawingNumber > derived(DataSource, zero-padded if needed)
-->
<#function viewerUrl lname f>
  <#-- choose raw id -->
  <#local rawA = (f["AsBuiltNumber"]?if_exists.value)!"" />
  <#local rawD = (f["DrawingNumber"]?if_exists.value)!"" />
  <#local rawS = "" />
  <#if !rawA?has_content && !rawD?has_content>
    <#local rawS = deriveIdFromDataSource(f) />
  </#if>
  <#local raw = rawA?has_content?then(rawA, rawD?has_content?then(rawD, rawS)) />
  <#if !raw?has_content><#return "" /></#if>

  <#-- normalize; only pad when derived from DataSource -->
  <#local fromDS = (!rawA?has_content && !rawD?has_content && rawS?has_content) />
  <#local norm = normalizeId(raw) />
  <#if fromDS>
    <#local norm = padSuffix3(norm) />
  </#if>

  <#local util   = chooseUtilityFolder(lname, f) />
  <#local area   = areaFor(f) />
  <#local idDir  = folderFrom(norm) />
  <#local basePath = enc_seg(ZIP_SEGMENT) + "/" + enc_seg(area) + "/" + util + "/" + enc_seg(idDir) />

  <#if hasHyphen(norm)>
    <#local ext      = EXT_ORDER[0] />
    <#local fullPath = basePath + "/" + enc_seg(norm) + ext />
    <#return BASE + "/index.html?view=" + qp_from_path(fullPath) />
  <#else>
    <#local fullPrefix = basePath + "/" />
    <#return BASE + "/index.html?prefix=" + qp_from_path(fullPrefix) />
  </#if>
</#function>

<#macro featureBlock lname f>
<pre>
Results for FeatureType '${lname}':
--------------------------------------------
GEOMETRY = [feature geometry]

<#list type.attributes as a>
  <#if !a.isGeometry>
${a.name} = ${(f[a.name]?if_exists.value)!""}
  </#if>
</#list>

<#-- Label which field we used (AsBuiltNumber / DrawingNumber / DataSource) -->
<#assign rawA = (f["AsBuiltNumber"]?if_exists.value)!"" />
<#assign rawD = (f["DrawingNumber"]?if_exists.value)!"" />
<#assign usedAsBuilt = rawA?has_content />
<#assign usedDrawing = (!usedAsBuilt && rawD?has_content) />
<#assign label = usedAsBuilt?then("AsBuiltNumber", usedDrawing?then("DrawingNumber","DataSource")) />

<#-- Compute normalized display value for clarity -->
<#assign raw = usedAsBuilt?then(rawA, usedDrawing?then(rawD, deriveIdFromDataSource(f))) />
<#assign norm = normalizeId(raw) />
<#if !usedAsBuilt && !usedDrawing>
  <#assign norm = padSuffix3(norm) />
</#if>

<#if norm?has_content>
  <#assign url = viewerUrl(lname, f) />
${label} = ${norm} <#if url?has_content>(<a class="asbuilt" href="${url}" target="_blank" rel="noopener">link</a>)</#if>

Viewer URL:
${url!""}
</#if>
</pre>
</#macro>

<#assign LNAME = layerNameFrom((type)!"") />
<#list features as f>
  <@featureBlock lname=LNAME f=f />
</#list>
