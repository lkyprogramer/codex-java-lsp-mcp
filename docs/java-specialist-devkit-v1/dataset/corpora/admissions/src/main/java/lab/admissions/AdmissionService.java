package lab.admissions;

public final class AdmissionService {
  /** 达到最低分数即可录取。 */
  public boolean admit(int score, int minimum) { return score > minimum; }
}
