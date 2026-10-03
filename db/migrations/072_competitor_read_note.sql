-- 競合の分析: Web サイトが分からない競合の一言を短くする（仕様書 第36.18節。2026-10-04 に三浦さんが「長すぎる」と指摘）
update competitors set read_note = 'Web サイトなし' where read_note = 'Web サイトが分からないため、読めませんでした';
