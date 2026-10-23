"""US/territory area code -> state lookup, used by Call Consumption's State page.

NEXUS stores no caller geography, so a call's "state" is the region of the AREA CODE of the contact's phone
number. That is an estimate: a mobile number that was ported or kept after a move still reports its old area
code. Numbers that are not +1 / 10-digit NANP numbers, toll-free codes, and area codes missing from the table
all land in UNKNOWN_STATE rather than being guessed.
"""
import re

UNKNOWN_STATE = "??"
UNKNOWN_STATE_NAME = "Unknown"

STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia",
    "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "PR": "Puerto Rico", "GU": "Guam", "VI": "U.S. Virgin Islands",
    UNKNOWN_STATE: UNKNOWN_STATE_NAME,
}

_CODES_BY_STATE = {
    "AL": "205 251 256 334 659 938",
    "AK": "907",
    "AZ": "480 520 602 623 928",
    "AR": "479 501 870",
    "CA": "209 213 279 310 323 341 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 "
          "747 760 805 818 820 831 858 909 916 925 949 951",
    "CO": "303 719 720 970 983",
    "CT": "203 475 860 959",
    "DE": "302",
    "DC": "202 771",
    "FL": "239 305 321 324 352 386 407 448 561 689 727 754 772 786 813 850 863 904 941 954",
    "GA": "229 404 470 478 678 706 762 770 912 943",
    "HI": "808",
    "ID": "208 986",
    "IL": "217 224 309 312 331 447 618 630 708 730 773 779 815 847 872",
    "IN": "219 260 317 463 574 765 812 930",
    "IA": "319 515 563 641 712",
    "KS": "316 620 785 913",
    "KY": "270 364 502 606 859",
    "LA": "225 318 337 504 985",
    "ME": "207",
    "MD": "240 301 410 443 667",
    "MA": "339 351 413 508 617 774 781 857 978",
    "MI": "231 248 269 313 517 586 616 734 810 906 947 989",
    "MN": "218 320 507 612 651 763 952",
    "MS": "228 601 662 769",
    "MO": "314 417 573 636 660 816 975",
    "MT": "406",
    "NE": "308 402 531",
    "NV": "702 725 775",
    "NH": "603",
    "NJ": "201 551 609 640 732 848 856 862 908 973",
    "NM": "505 575",
    "NY": "212 315 332 347 363 516 518 585 607 631 646 680 716 718 838 845 914 917 929 934",
    "NC": "252 336 704 743 828 910 919 980 984",
    "ND": "701",
    "OH": "216 220 234 326 330 380 419 440 513 567 614 740 937",
    "OK": "405 539 572 580 918",
    "OR": "458 503 541 971",
    "PA": "215 223 267 272 412 445 484 570 610 717 724 814 835 878",
    "RI": "401",
    "SC": "803 839 843 854 864",
    "SD": "605",
    "TN": "423 615 629 731 865 901 931",
    "TX": "210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 "
          "940 956 972 979",
    "UT": "385 435 801",
    "VT": "802",
    "VA": "276 434 540 571 703 757 804 826 948",
    "WA": "206 253 360 425 509 564",
    "WV": "304 681",
    "WI": "262 274 414 534 608 715 920",
    "WY": "307",
    "PR": "787 939",
    "GU": "671",
    "VI": "340",
}

AREA_CODE_STATE = {code: st for st, codes in _CODES_BY_STATE.items() for code in codes.split()}

_NON_DIGITS = re.compile(r"\D")


def area_code_of(phone) -> str | None:
    """The 3-digit area code of a US/Canada-style number ("+1 (303) 555-0100", "3035550100", "13035550100"),
    or None when the number is not a NANP number."""
    digits = _NON_DIGITS.sub("", str(phone or ""))
    if len(digits) == 11 and digits[0] == "1":
        digits = digits[1:]
    if len(digits) == 10 and digits[0] in "23456789":
        return digits[:3]
    return None


def state_for_area_code(area_code: str | None) -> str:
    """The 2-letter state code for an area code, or UNKNOWN_STATE."""
    return AREA_CODE_STATE.get(area_code or "", UNKNOWN_STATE)


def state_for_phone(phone) -> str:
    return state_for_area_code(area_code_of(phone))
