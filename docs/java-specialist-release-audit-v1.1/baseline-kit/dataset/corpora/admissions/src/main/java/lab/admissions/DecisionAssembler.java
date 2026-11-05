package lab.admissions;

public final class DecisionAssembler {
  public String status(boolean admitted) { return admitted ? "ADMITTED" : "REJECTED"; }
}
