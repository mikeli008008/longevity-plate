# Builds the standalone index.html from the shared app source (diet-app/index.html).
import pathlib,sys
src=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else 'src/app.html').read_text()
inject='''<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
<script src="config.js"></script>
<script src="lp-standalone.js"></script>
<script>'''
marker='<script>\n/* ================= i18n'
assert marker in src
out=src.replace(marker,inject+'\n/* ================= i18n',1)
pathlib.Path('index.html').write_text(out)
print('built index.html',len(out))
