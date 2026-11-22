// WRITE-UP TEXT — fills the "Value added" and "Data, cleaning" sections of the page.
// It is only text templates: every number comes from the data (D, P) defined in data.js / main.js,
// so the write-up can never disagree with the chart. No drawing happens here.

// numbers used in the text
const yearTotals=y=>{ const k=ix(y,1), z=P.slice(k,k+12); return [d3.sum(z,p=>p.s),d3.sum(z,p=>p.mo),d3.sum(z,p=>p.op)]; };
const [s21,m21,o21]=yearTotals(2021), [s24,m24,o24]=yearTotals(2024);
const z26=P.slice(ix(2026,1)), o26=d3.sum(z26,p=>p.op)/d3.sum(z26,p=>p.s);
const correlation=(a,b)=>{ const ma=d3.mean(a), mb=d3.mean(b); let u=0,v=0,w=0; a.forEach((_,i)=>{u+=(a[i]-ma)*(b[i]-mb);v+=(a[i]-ma)**2;w+=(b[i]-mb)**2}); return u/Math.sqrt(v*w); };
const corrAll=correlation(P.map(p=>p.r),P.map(p=>p.s)), corr22=correlation(P.slice(84).map(p=>p.r),P.slice(84).map(p=>p.s));
const pct=v=>Math.round(v*100)+'%', c=D.c;

d3.select('#val').html(`<p><b>What it shows.</b> In the sample, sales rose ${s21.toLocaleString()} → ${s24.toLocaleString()} (×${(s24/s21).toFixed(1)}) from 2021 to 2024 while the policy rate went from 0.15% to a 5.40% peak. Mortgage registrations per 100 sales fell from ${Math.round(100*m21/s21)} to ${Math.round(100*m24/s24)}. The path does not follow the textbook arrow.</p>
<p><b>Why that ratio matters.</b> Higher rates should hit people who borrow first. Counting mortgage registrations per 100 sales (both counts come from the same 10% sample, so the sampling cancels out) shows whether sales growth came with more bank lending. It did not: sales tripled while the ratio fell by about ${Math.round(100*(1-(m24/s24)/(m21/s21)))}%.</p>
<p><b>Why it may not follow it</b> (hypotheses; the chart cannot prove them):</p><ul>
<li><b>Fewer sales have a matching mortgage registration.</b> Registrations are separate transactions, not linked to individual buyers, so this is a ratio, not a count of cash buyers.</li>
<li><b>Off-plan growth.</b> Off-plan was ${pct(o21/s21)} of sales in 2021, ${pct(o24/s24)} in 2024 and ${pct(o26)} in 2026 (in the sample). Off-plan buyers typically pay developers in instalments, so a falling ratio does not by itself mean more cash buyers.</li>
<li><b>A low starting point.</b> Sales collapsed in 2020; the rise from 2021 includes post-COVID recovery, so rates were hiked into a rebound.</li>
<li><b>Imported rates.</b> The CBUAE rate is anchored to the US Federal Reserve’s rate, so the hikes reflect US policy, not Dubai’s own market.</li>
<li><b>Other demand drivers</b> (population growth, investor inflows, supply launches) are not in this dataset and are untested here; rate effects may also act with a lag.</li></ul>
<p><b>Mix of property types.</b> “Sales” cover all property types (units, villas, land), not only apartments. Flats were about ${c.flat21}% of sales rows in 2021 and about ${c.flat24}% in 2024, so part of the change in the ratio may reflect the changing mix. A flats-only version was not run.</p>
<p><b>Caution.</b> Across all months, rate and sales correlate at ${corrAll.toFixed(2)}, but only because both trend upward over time; from 2022 on it is ${corr22.toFixed(2)}. The scatterplot shows association through time, not cause and effect. Sales in the sample also dipped in 2026 (Jan–Aug) despite lower rates, which further weakens any simple rate story.</p>`);

d3.select('#dat').html(`<p><b>Primary data:</b> Dubai Land Department transactions, 10% random sample (<code>transactions.csv</code>, ${c.rows.toLocaleString()} rows). We did not sample; every count is a sample count and is not scaled up. Window: Jan 2015 – Aug 2026 (shared by all seats).</p>
<p><b>Cleaning:</b></p><ul>
<li><b>Dates:</b> ${c.badDate} unparseable dates. ${c.before2015.toLocaleString()} rows dated before 2015 and ${c.sep2026} rows in the partial month Sep 2026 are outside the window and dropped. Dates are the legal event date (<code>instance_date</code>). ${c.idYearMismatch} rows whose transaction-ID year differs from the date are kept.</li>
<li><b>Missing days:</b> we aggregate by month, so missing days do not matter; every month in the window has data.</li>
<li><b>Prices:</b> ${c.lowPrice} rows with price missing or under AED 10,000 (e.g. a flat at AED 823) are dropped as implausible; there are no zero prices. Extremely high prices are not capped (the largest is AED ${(c.maxWorth/1e6).toFixed(0)} million) because no chart displays prices.</li>
<li><b>Missing values:</b> none in date, transaction group, price or property type. <code>property_sub_type_en</code> is empty for ${c.nullSub.toLocaleString()} rows (mostly land and buildings); we do not use it.</li>
<li><b>Duplicates:</b> ${c.dup} duplicate transaction IDs and no fully identical rows in the window. Kept: ${c.kept.toLocaleString()} rows.</li></ul>
<p><b>Definitions:</b> Sales = <code>trans_group_en = Sales</code>, all procedures and all property types (about 78% units, 13% villas, 9% land, under 1% buildings). Mortgages = <code>trans_group_en = Mortgages</code>, all types. Off-plan = <code>reg_type_en = Off-Plan Properties</code>. Mortgage registrations per 100 sales = 100 × Mortgages ÷ Sales per month: a proxy for financing, since registrations include refinancing and modifications and are not linked to individual sales. “Smoothed” = centred 3-month average; “exact” = the single month. Other seats may use narrower definitions (e.g. units only), so their numbers will differ.</p>
<p><b>External data — interest rate:</b> Central Bank of the UAE (CBUAE) press releases (centralbank.ae), cross-checked with Trading Economics. <b>Join:</b> each transaction’s <code>instance_date</code> is reduced to year-month and each month is given the rate in force at month-end. Two instruments are used: (1) <b>Jul 2020 onward: CBUAE Base Rate</b> (e.g. 17 Mar 2022 rise to 0.40%, 10 Dec 2025 cut to 3.65%). (2) <b>Jan 2015 – Jun 2020: CBUAE repo rate</b>, which moved in lockstep with the US Fed’s upper target (repo = Fed upper bound + 0.25 pp). Checked against announcements: 16 Mar 2017 rise, repo 1.75% in Dec 2017, certificate-of-deposit rate 1.75% (Mar 2018) and 2.25% (Sep 2018), and the Dec 2018 rise. <b>The other months (2015 – Feb 2017, 2019 – Jun 2020) are inferred from that rule and not individually verified.</b> The drop in Jul 2020 is a change of instrument, not a policy move. We have not used EIBOR or FRED series.</p>
<p><b>Phases</b> (colour) are defined by the rate path. <b>Design choice:</b> the overview is a 100% stacked area of the mortgage ratio rather than raw counts, so it differs from a plain monthly sales line.</p>`);

