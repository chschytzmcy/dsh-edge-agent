import re


def is_valid_cn_mobile(number: str) -> bool:
    """
    Validate a Chinese mainland mobile phone number.

    Rules:
      - 11 digits total
      - starts with `1`
      - second digit is 3-9 (covers all current carriers)
      - all remaining digits are 0-9

    Examples:
      is_valid_cn_mobile("13800138000") -> True
      is_valid_cn_mobile("12345678901") -> False  # second digit not 3-9
      is_valid_cn_mobile("1380013800")  -> False  # only 10 digits
    """
    if not isinstance(number, str):
        return False

    number = number.strip()

    # 1[3-9] followed by 9 digits -> 11 digits total
    return bool(re.fullmatch(r"1[3-9]\d{9}", number))
