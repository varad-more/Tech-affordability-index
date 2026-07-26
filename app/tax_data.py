"""
2026 US tax constants — single filer, standard deduction, no dependents.

Every figure below carries the source it came from. When a new tax year lands,
this is the only module that needs editing: 'tax.py' holds no numbers.

Brackets are 'Bracket(lower, rate)' where 'lower' is the INCLUSIVE lower
bound of the bracket in taxable-income dollars, sorted ascending. The field is
named 'lower' rather than 'from' because 'from' is a Python keyword.

GENERATED from the JavaScript original during the Flask port, not retyped —
fifty states of bracket tables is precisely where hand-transcription introduces
a silent numeric bug. 'tests/test_parity.py' pins every figure here against
the engine it came from.
"""

from typing import Dict, NamedTuple, Optional, Tuple


class Bracket(NamedTuple):
    """One marginal band: everything at or above 'lower' is charged 'rate'."""

    lower: float
    rate: float


class Levy(NamedTuple):
    """An employee-side payroll levy. 'cap' of None means no wage ceiling."""

    label: str
    rate: float
    cap: Optional[float] = None


class State(NamedTuple):
    name: str
    standard_deduction: float
    brackets: Tuple[Bracket, ...]
    payroll: Tuple[Levy, ...]


class Locality(NamedTuple):
    """A city income tax.

    'base' is 'state_taxable' when the tax applies to income after the state's
    own deduction, or 'gross' when it applies to gross wages with none.
    """

    name: str
    base: str
    brackets: Tuple[Bracket, ...]
    source: str
    note: Optional[str] = None


TAX_YEAR = 2026
FILING_STATUS = "single"

SOURCES: Dict[str, Dict[str, str]] = {
    "federal": {
        "url": "https://taxfoundation.org/data/all/federal/2026-tax-brackets/",
        "note": "IRS Rev. Proc. 2025-32 inflation adjustments (post-OBBBA)",
        "asOf": "2026-01-01",
    },
    "fica": {
        "url": "https://www.ssa.gov/oact/cola/cbb.html",
        "note": "SSA contribution and benefit base 2026",
        "asOf": "2026-01-01",
    },
    "states": {
        "url": "https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/",
        "note": "Tax Foundation, State Individual Income Tax Rates and Brackets 2026",
        "asOf": "2026-02-11",
    },
}

#: Federal ordinary income tax.
FEDERAL_STANDARD_DEDUCTION = 16100
FEDERAL_BRACKETS: Tuple[Bracket, ...] = (
    Bracket(0, 0.1),
    Bracket(12400, 0.12),
    Bracket(50400, 0.22),
    Bracket(105700, 0.24),
    Bracket(201775, 0.32),
    Bracket(256225, 0.35),
    Bracket(640600, 0.37),
)

#: FICA. The Social Security wage base is indexed annually; the 0.9% Additional
#: Medicare Tax threshold is fixed in statute at $200,000 for single filers and
#: is NOT inflation-adjusted.
SOCIAL_SECURITY_RATE = 0.062
SOCIAL_SECURITY_WAGE_BASE = 184500
MEDICARE_RATE = 0.0145
ADDITIONAL_MEDICARE_RATE = 0.009
ADDITIONAL_MEDICARE_THRESHOLD = 200000

PAYROLL_MODELLED_STATES = ('CA','WA',)

PAYROLL_COVERAGE_NOTE = (
    "State paid-leave and disability payroll levies are modelled for California and Washington only. Roughly a dozen other states run employee-funded programmes of about 0.3-0.7% of wages, which are not included, so take-home in those states is overstated slightly."
)

STATES: Dict[str, State] = {
    "CA": State(
        name="California",
        standard_deduction=5540,
        brackets=(
            Bracket(0, 0.011),
            Bracket(11079, 0.022),
            Bracket(26264, 0.044),
            Bracket(41452, 0.066),
            Bracket(57542, 0.088),
            Bracket(72724, 0.093),
            Bracket(371479, 0.103),
            Bracket(445771, 0.113),
            Bracket(742953, 0.123),
            Bracket(1000000, 0.133),
        ),
        payroll=(
            Levy("CA SDI", 0.013, None),
        ),
    ),
    "NY": State(
        name="New York",
        standard_deduction=8000,
        brackets=(
            Bracket(0, 0.039),
            Bracket(8500, 0.044),
            Bracket(11700, 0.0515),
            Bracket(13900, 0.054),
            Bracket(80650, 0.059),
            Bracket(215400, 0.0685),
            Bracket(1077550, 0.0965),
            Bracket(5000000, 0.103),
            Bracket(25000000, 0.109),
        ),
        payroll=(),
    ),
    "WA": State(
        name="Washington",
        standard_deduction=0,
        brackets=(),
        payroll=(
            Levy("WA Paid Family & Medical Leave", 0.00807159, 184500),
            Levy("WA Cares", 0.0058, None),
        ),
    ),
    "MA": State(
        name="Massachusetts",
        standard_deduction=4400,
        brackets=(
            Bracket(0, 0.05),
            Bracket(1083150, 0.09),
        ),
        payroll=(),
    ),
    "IL": State(
        name="Illinois",
        standard_deduction=0,
        brackets=(
            Bracket(0, 0.0495),
        ),
        payroll=(),
    ),
    "CO": State(
        name="Colorado",
        standard_deduction=16100,
        brackets=(
            Bracket(0, 0.044),
        ),
        payroll=(),
    ),
    "GA": State(
        name="Georgia",
        standard_deduction=12000,
        brackets=(
            Bracket(0, 0.0519),
        ),
        payroll=(),
    ),
    "NC": State(
        name="North Carolina",
        standard_deduction=12750,
        brackets=(
            Bracket(0, 0.0399),
        ),
        payroll=(),
    ),
    "OR": State(
        name="Oregon",
        standard_deduction=2910,
        brackets=(
            Bracket(0, 0.0475),
            Bracket(4550, 0.0675),
            Bracket(11400, 0.0875),
            Bracket(125000, 0.099),
        ),
        payroll=(),
    ),
    "VA": State(
        name="Virginia",
        standard_deduction=8750,
        brackets=(
            Bracket(0, 0.02),
            Bracket(3000, 0.03),
            Bracket(5000, 0.05),
            Bracket(17000, 0.0575),
        ),
        payroll=(),
    ),
    "AZ": State(
        name="Arizona",
        standard_deduction=8350,
        brackets=(
            Bracket(0, 0.025),
        ),
        payroll=(),
    ),
    "UT": State(
        name="Utah",
        standard_deduction=0,
        brackets=(
            Bracket(0, 0.045),
        ),
        payroll=(),
    ),
    "MN": State(
        name="Minnesota",
        standard_deduction=15300,
        brackets=(
            Bracket(0, 0.0535),
            Bracket(33310, 0.068),
            Bracket(109430, 0.0785),
            Bracket(203150, 0.0985),
        ),
        payroll=(),
    ),
    "PA": State(
        name="Pennsylvania",
        standard_deduction=0,
        brackets=(
            Bracket(0, 0.0307),
        ),
        payroll=(),
    ),
    "AL": State(
        name="Alabama",
        standard_deduction=3000,
        brackets=(
            Bracket(0, 0.02),
            Bracket(500, 0.04),
            Bracket(3000, 0.05),
        ),
        payroll=(),
    ),
    "AR": State(
        name="Arkansas",
        standard_deduction=2470,
        brackets=(
            Bracket(0, 0.02),
            Bracket(4600, 0.039),
        ),
        payroll=(),
    ),
    "CT": State(
        name="Connecticut",
        standard_deduction=0,
        brackets=(
            Bracket(0, 0.02),
            Bracket(10000, 0.045),
            Bracket(50000, 0.055),
            Bracket(100000, 0.06),
            Bracket(200000, 0.065),
            Bracket(250000, 0.069),
            Bracket(500000, 0.0699),
        ),
        payroll=(),
    ),
    "DE": State(
        name="Delaware",
        standard_deduction=3250,
        brackets=(
            Bracket(0, 0),
            Bracket(2000, 0.022),
            Bracket(5000, 0.039),
            Bracket(10000, 0.048),
            Bracket(20000, 0.052),
            Bracket(25000, 0.0555),
            Bracket(60000, 0.066),
        ),
        payroll=(),
    ),
    "HI": State(
        name="Hawaii",
        standard_deduction=4400,
        brackets=(
            Bracket(0, 0.014),
            Bracket(9600, 0.032),
            Bracket(14400, 0.055),
            Bracket(19200, 0.064),
            Bracket(24000, 0.068),
            Bracket(36000, 0.072),
            Bracket(48000, 0.076),
            Bracket(125000, 0.079),
            Bracket(175000, 0.0825),
            Bracket(225000, 0.09),
            Bracket(275000, 0.1),
            Bracket(325000, 0.11),
        ),
        payroll=(),
    ),
    "ID": State(
        name="Idaho",
        standard_deduction=16100,
        brackets=(
            Bracket(0, 0),
            Bracket(4811, 0.053),
        ),
        payroll=(),
    ),
    "IN": State(
        name="Indiana",
        standard_deduction=0,
        brackets=(
            Bracket(0, 0.0295),
        ),
        payroll=(),
    ),
    "IA": State(
        name="Iowa",
        standard_deduction=16100,
        brackets=(
            Bracket(0, 0.038),
        ),
        payroll=(),
    ),
    "KS": State(
        name="Kansas",
        standard_deduction=3605,
        brackets=(
            Bracket(0, 0.052),
            Bracket(23000, 0.0558),
        ),
        payroll=(),
    ),
    "KY": State(
        name="Kentucky",
        standard_deduction=3360,
        brackets=(
            Bracket(0, 0.035),
        ),
        payroll=(),
    ),
    "LA": State(
        name="Louisiana",
        standard_deduction=12875,
        brackets=(
            Bracket(0, 0.03),
        ),
        payroll=(),
    ),
    "ME": State(
        name="Maine",
        standard_deduction=8350,
        brackets=(
            Bracket(0, 0.058),
            Bracket(27399, 0.0675),
            Bracket(64849, 0.0715),
        ),
        payroll=(),
    ),
    "MD": State(
        name="Maryland",
        standard_deduction=3350,
        brackets=(
            Bracket(0, 0.02),
            Bracket(1000, 0.03),
            Bracket(2000, 0.04),
            Bracket(3000, 0.0475),
            Bracket(100000, 0.05),
            Bracket(125000, 0.0525),
            Bracket(150000, 0.055),
            Bracket(250000, 0.0575),
            Bracket(500000, 0.0625),
            Bracket(1000000, 0.065),
        ),
        payroll=(),
    ),
    "MI": State(
        name="Michigan",
        standard_deduction=0,
        brackets=(
            Bracket(0, 0.0425),
        ),
        payroll=(),
    ),
    "MS": State(
        name="Mississippi",
        standard_deduction=2300,
        brackets=(
            Bracket(0, 0),
            Bracket(10000, 0.04),
        ),
        payroll=(),
    ),
    "MO": State(
        name="Missouri",
        standard_deduction=16100,
        brackets=(
            Bracket(0, 0),
            Bracket(1348, 0.02),
            Bracket(2696, 0.025),
            Bracket(4044, 0.03),
            Bracket(5392, 0.035),
            Bracket(6740, 0.04),
            Bracket(8088, 0.045),
            Bracket(9436, 0.047),
        ),
        payroll=(),
    ),
    "MT": State(
        name="Montana",
        standard_deduction=16100,
        brackets=(
            Bracket(0, 0.047),
            Bracket(47500, 0.0565),
        ),
        payroll=(),
    ),
    "NE": State(
        name="Nebraska",
        standard_deduction=8850,
        brackets=(
            Bracket(0, 0.0246),
            Bracket(4130, 0.0351),
            Bracket(24760, 0.0455),
        ),
        payroll=(),
    ),
    "NJ": State(
        name="New Jersey",
        standard_deduction=0,
        brackets=(
            Bracket(0, 0.014),
            Bracket(20000, 0.0175),
            Bracket(35000, 0.035),
            Bracket(40000, 0.0553),
            Bracket(75000, 0.0637),
            Bracket(500000, 0.0897),
            Bracket(1000000, 0.1075),
        ),
        payroll=(),
    ),
    "NM": State(
        name="New Mexico",
        standard_deduction=16100,
        brackets=(
            Bracket(0, 0.015),
            Bracket(5500, 0.032),
            Bracket(16500, 0.043),
            Bracket(33500, 0.047),
            Bracket(66500, 0.049),
            Bracket(210000, 0.059),
        ),
        payroll=(),
    ),
    "ND": State(
        name="North Dakota",
        standard_deduction=16100,
        brackets=(
            Bracket(0, 0),
            Bracket(48475, 0.0195),
            Bracket(244825, 0.025),
        ),
        payroll=(),
    ),
    "OH": State(
        name="Ohio",
        standard_deduction=0,
        brackets=(
            Bracket(0, 0),
            Bracket(26050, 0.0275),
        ),
        payroll=(),
    ),
    "OK": State(
        name="Oklahoma",
        standard_deduction=6350,
        brackets=(
            Bracket(0, 0),
            Bracket(3750, 0.025),
            Bracket(4900, 0.035),
            Bracket(7200, 0.045),
        ),
        payroll=(),
    ),
    "RI": State(
        name="Rhode Island",
        standard_deduction=11200,
        brackets=(
            Bracket(0, 0.0375),
            Bracket(82050, 0.0475),
            Bracket(186450, 0.0599),
        ),
        payroll=(),
    ),
    "SC": State(
        name="South Carolina",
        standard_deduction=8350,
        brackets=(
            Bracket(0, 0),
            Bracket(3640, 0.03),
            Bracket(18230, 0.06),
        ),
        payroll=(),
    ),
    "VT": State(
        name="Vermont",
        standard_deduction=7650,
        brackets=(
            Bracket(0, 0.0335),
            Bracket(49400, 0.066),
            Bracket(119700, 0.076),
            Bracket(249700, 0.0875),
        ),
        payroll=(),
    ),
    "WV": State(
        name="West Virginia",
        standard_deduction=0,
        brackets=(
            Bracket(0, 0.0222),
            Bracket(10000, 0.0296),
            Bracket(25000, 0.0333),
            Bracket(40000, 0.0444),
            Bracket(60000, 0.0482),
        ),
        payroll=(),
    ),
    "WI": State(
        name="Wisconsin",
        standard_deduction=13960,
        brackets=(
            Bracket(0, 0.035),
            Bracket(15110, 0.044),
            Bracket(51950, 0.053),
            Bracket(332720, 0.0765),
        ),
        payroll=(),
    ),
    "DC": State(
        name="District of Columbia",
        standard_deduction=16100,
        brackets=(
            Bracket(0, 0.04),
            Bracket(10000, 0.06),
            Bracket(40000, 0.065),
            Bracket(60000, 0.085),
            Bracket(250000, 0.0925),
            Bracket(500000, 0.0975),
            Bracket(1000000, 0.1075),
        ),
        payroll=(),
    ),
    "TX": State(
        name="Texas",
        standard_deduction=0,
        brackets=(),
        payroll=(),
    ),
    "FL": State(
        name="Florida",
        standard_deduction=0,
        brackets=(),
        payroll=(),
    ),
    "TN": State(
        name="Tennessee",
        standard_deduction=0,
        brackets=(),
        payroll=(),
    ),
    "NV": State(
        name="Nevada",
        standard_deduction=0,
        brackets=(),
        payroll=(),
    ),
    "AK": State(
        name="Alaska",
        standard_deduction=0,
        brackets=(),
        payroll=(),
    ),
    "SD": State(
        name="South Dakota",
        standard_deduction=0,
        brackets=(),
        payroll=(),
    ),
    "WY": State(
        name="Wyoming",
        standard_deduction=0,
        brackets=(),
        payroll=(),
    ),
    "NH": State(
        name="New Hampshire",
        standard_deduction=0,
        brackets=(),
        payroll=(),
    ),
}

#: Local income taxes that are NOT computed, declared so the pages can warn.
#:
#:   scope 'county'    — every resident pays, set at county level
#:   scope 'municipal' — varies by city or township within the county
#:   scope 'city'      — only specific named cities levy it
UNMODELLED_LOCAL_TAX: Dict[str, Dict[str, str]] = {
    "MD": {
        "scope": "county",
        "typical": "2.25-3.30%",
        "note": "Every Maryland county and Baltimore City levies a local income tax.",
    },
    "IN": {
        "scope": "county",
        "typical": "0.5-3%",
        "note": "All 92 Indiana counties levy a local income tax.",
    },
    "OH": {
        "scope": "municipal",
        "typical": "1-2.5%",
        "note": "Most Ohio municipalities levy an income tax; some school districts add another.",
    },
    "PA": {
        "scope": "municipal",
        "typical": "1-2%",
        "note": "Pennsylvania municipalities levy an Earned Income Tax. Philadelphia is modelled; the rest are not.",
    },
    "MI": {
        "scope": "city",
        "typical": "1-2.4%",
        "note": "Twenty-four Michigan cities, including Detroit and Grand Rapids, levy an income tax.",
    },
    "KY": {
        "scope": "municipal",
        "typical": "0.5-2.5%",
        "note": "Many Kentucky counties and cities levy an occupational licence tax on wages.",
    },
    "MO": {
        "scope": "city",
        "typical": "1%",
        "note": "Kansas City and St. Louis levy a 1% earnings tax; the rest of Missouri does not.",
    },
    "AL": {
        "scope": "city",
        "typical": "0.5-2%",
        "note": "Several Alabama cities, including Birmingham, levy an occupational tax.",
    },
    "NY": {
        "scope": "city",
        "typical": "3-3.9%",
        "note": "New York City is modelled. Yonkers levies a surcharge that is not.",
    },
    "OR": {
        "scope": "municipal",
        "typical": "0.8-2.5%",
        "note": "Portland-area residents pay Metro and Multnomah County income taxes.",
    },
    "IA": {
        "scope": "municipal",
        "typical": "0-20% surtax",
        "note": "Iowa school districts levy a surtax on state income tax liability.",
    },
    "DE": {
        "scope": "city",
        "typical": "1.25%",
        "note": "Wilmington levies a wage tax; the rest of Delaware does not.",
    },
    "WV": {
        "scope": "city",
        "typical": "$2-5/week",
        "note": "Some West Virginia cities levy a flat weekly service fee rather than a rate.",
    },
    "CO": {
        "scope": "city",
        "typical": "$4-6/month",
        "note": "A few Colorado cities levy a small flat occupational privilege tax.",
    },
    "NJ": {
        "scope": "city",
        "typical": "1%",
        "note": "Newark levies a payroll tax, generally on employers rather than employees.",
    },
}

#: City-level income taxes that ARE computed. Omitting these materially flatters
#: the affected metros — NYC's top resident rate alone is ~3.9%.
LOCAL: Dict[str, Locality] = {
    "NYC": Locality(
        name="New York City resident income tax",
        base="state_taxable",
        brackets=(
            Bracket(0, 0.03078),
            Bracket(12000, 0.03762),
            Bracket(25000, 0.03819),
            Bracket(50000, 0.03876),
        ),
        source="https://www.tax.ny.gov/pit/file/new-york-city-tax-rates.htm",
    ),
    "PHL": Locality(
        name="Philadelphia resident wage tax",
        base="gross",
        brackets=(
            Bracket(0, 0.03735),
        ),
        source="https://www.phila.gov/services/payments-assistance-taxes/taxes/income-taxes/earnings-tax-employees/",
        note="Rate effective July 1, 2026 (reduced from 3.75%)",
    ),
}
