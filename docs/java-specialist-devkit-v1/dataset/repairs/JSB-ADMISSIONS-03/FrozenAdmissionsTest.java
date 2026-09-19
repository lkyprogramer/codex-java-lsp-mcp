package lab.admissions;

public class FrozenAdmissionsTest {
  public static void main(String[] args) {
    AdmissionService s=new AdmissionService();
    if(!s.admit(60,60)||!s.admit(61,60)||s.admit(59,60))throw new AssertionError("threshold");
    if(!s.admit(Integer.MIN_VALUE,Integer.MIN_VALUE))throw new AssertionError("lower bound");
  }
}
